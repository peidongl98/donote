#!/usr/bin/env node
/**
 * DoNote 回归运行器（唯一入口，替代 harness/run-all.sh 的日常用法）
 *
 *   node scripts/regression/run-regression.cjs                     # 全套
 *   node scripts/regression/run-regression.cjs --suites=notes,life
 *   node scripts/regression/run-regression.cjs --module=cache
 *   node scripts/regression/run-regression.cjs --changed           # 按 git 改动自动选
 *   node scripts/regression/run-regression.cjs --changed=origin/main
 *   node scripts/regression/run-regression.cjs --real --suites=attach
 *   node scripts/regression/run-regression.cjs --explain --module=editor
 *
 * 只依赖 Node 内置模块。套件本体在 scripts/regression/suites，假 DAV 在 scripts/regression/harness，
 * 日志落在 scripts/regression/.logs（都不入库）。
 * 「改动 → 该跑哪些套件」的对应关系全在 scripts/regression/regression-map.json，
 * 改映射表不用动这个文件。本机相关路径（playwright-core 的 node_modules、密钥文件、账号）
 * 放 scripts/regression/local.json（从 local.example.json 复制，不入库），也可用环境变量覆盖：
 *   DONOTE_NODE_PATH / DONOTE_SECRETS / DONOTE_ACCOUNT / DONOTE_ARTIFACTS_DIR
 *
 * 退出码：0 全绿；1 有 FAIL / 套件未跑完 / 套件非正常退出 / 超时；2 用法或环境错误。
 *
 * 🔴 判「未跑完」靠映射表里每套的 `checks`（预期断言项数）：套件崩在半路时进程照样会 print
 * 已跑完的 PASS 行，只数 PASS/FAIL 会把「19/39」看成全绿（attach 就这么漏过一次）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MAP_PATH = path.join(__dirname, 'regression-map.json');
const LOCAL_PATH = path.join(__dirname, 'local.json');

const OPTS_WITH_VALUE = new Set([
  'suites',
  'module',
  'changed',
  'gap',
  'timeout',
  'base',
  'suites-dir',
  'harness-dir',
  'log-dir',
  'node-path',
]);

// ─────────────────────────────────────────────────────────── 参数

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._ = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (OPTS_WITH_VALUE.has(key) && next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }
  return { flags, opts };
}

const { flags, opts } = parseArgs(process.argv.slice(2));
if (flags.has('help') || flags.has('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

const usage = (msg) => {
  console.error(`用法错误：${msg}`);
  console.error('看帮助：node scripts/regression/run-regression.cjs --help');
  process.exit(2);
};

// ─────────────────────────────────────────────────────────── 映射表

if (!fs.existsSync(MAP_PATH)) usage(`找不到映射表 ${MAP_PATH}`);
const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
const SUITE_ORDER = Object.keys(map.suites);

// 本机相关配置：local.json（不入库）→ 环境变量 → 映射表默认值。CLI 参数优先级最高。
const local = fs.existsSync(LOCAL_PATH)
  ? JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'))
  : {};

const suitesDir = path.resolve(
  REPO,
  opts['suites-dir'] || opts['harness-dir'] || map.suitesDir,
);
const logDir = path.resolve(
  REPO,
  opts['log-dir'] || local.logDir || map.logDir || 'scripts/regression/.logs',
);
const nodePath =
  opts['node-path'] ||
  process.env.DONOTE_NODE_PATH ||
  local.nodePath ||
  process.env.NODE_PATH ||
  '';
const base = opts.base || local.base || process.env.BASE || map.baseUrl || 'http://localhost:5173';
const isReal = flags.has('real');
const gapSec = Number(opts.gap ?? (isReal ? 60 : 0));
const timeoutSec = Number(opts.timeout ?? 600);

if (!fs.existsSync(suitesDir)) usage(`套件目录不存在：${suitesDir}（用 --suites-dir 指定）`);

// ─────────────────────────────────────────────────────────── 路径匹配

function globToRegExp(pattern) {
  let re = '';
  const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += esc(c);
    }
  }
  return new RegExp(`^${re}$`);
}

const ICON_OR_CACHE = /(^|\/)node_modules\//;
const compiled = {
  modules: Object.entries(map.modules).map(([key, mod]) => ({
    key,
    mod,
    res: mod.paths.map(globToRegExp),
  })),
  full: (map.fullRunTriggers?.paths || []).map(globToRegExp),
  ignore: (map.ignorePaths?.paths || []).map(globToRegExp),
};

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const hits = (list, p) => list.some((re) => re.test(p));

// ─────────────────────────────────────────────────────────── 选择套件

/** 名称宽松匹配：notes / notes-e2e / notes-e2e.cjs 都认 */
function resolveSuite(name) {
  const want = norm(name.trim());
  if (map.suites[want]) return want;
  const byFile = SUITE_ORDER.find(
    (k) => map.suites[k].file === want || map.suites[k].file === `${want}.cjs`,
  );
  if (byFile) return byFile;
  const loose = SUITE_ORDER.find((k) => k.startsWith(want) || map.suites[k].file.startsWith(want));
  if (loose) return loose;
  usage(`不认识套件「${name}」。可用：${SUITE_ORDER.join(', ')}`);
}

function resolveModule(name) {
  const want = norm(name.trim()).replace(/\/+$/, '');
  if (map.modules[want]) return want;
  const loose = Object.keys(map.modules).find((k) => k.startsWith(want));
  if (loose) return loose;
  usage(`不认识模块「${name}」。可用：${Object.keys(map.modules).join(', ')}`);
}

function gitChangedPaths(ref) {
  const { execFileSync } = require('node:child_process');
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (err) {
      usage(`git ${args.join(' ')} 失败：${(err.stderr || err.message).toString().trim()}`);
    }
  };
  const all = [
    ...run(['diff', '--name-only', ref]),
    ...run(['ls-files', '--others', '--exclude-standard']),
  ];
  return [...new Set(all.map(norm).filter((p) => !ICON_OR_CACHE.test(p)))];
}

function select() {
  const picked = new Map(); // suite -> Set<原因>
  const notes = [];
  const add = (suite, why) => {
    if (!picked.has(suite)) picked.set(suite, new Set());
    picked.get(suite).add(why);
  };
  const addAll = (why) => {
    for (const s of SUITE_ORDER) add(s, why);
  };

  let explicit = 0;

  if (flags.has('all') || flags.has('full')) {
    addAll('--all');
    explicit++;
  }

  if (opts.suites) {
    for (const raw of opts.suites.split(',')) {
      if (!raw.trim()) continue;
      add(resolveSuite(raw), '--suites');
      explicit++;
    }
  }

  if (opts.module) {
    for (const raw of opts.module.split(',')) {
      if (!raw.trim()) continue;
      const key = resolveModule(raw);
      for (const s of map.modules[key].suites) add(s, `--module=${key}`);
      explicit++;
    }
  }

  if (flags.has('changed') || opts.changed !== undefined) {
    const ref = opts.changed || 'HEAD';
    const paths = gitChangedPaths(ref);
    if (paths.length === 0) {
      notes.push(`--changed：相对 ${ref} 没有改动`);
    } else {
      const ignored = [];
      let unknown = [];
      for (const p of paths) {
        if (hits(compiled.full, p)) return { picked, notes, all: true, allWhy: `触发全套：${p}`, changed: paths };
        if (hits(compiled.ignore, p)) {
          ignored.push(p);
          continue;
        }
        const mods = compiled.modules.filter((m) => hits(m.res, p));
        if (mods.length === 0) {
          unknown.push(p);
          continue;
        }
        for (const m of mods) {
          for (const s of map.modules[m.key].suites) add(s, `${m.key} ← ${p}`);
        }
      }
      if (unknown.length) {
        return {
          picked,
          notes,
          all: true,
          allWhy: `有未归类改动，保守起见跑全套：${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` 等 ${unknown.length} 个` : ''}`,
          changed: paths,
        };
      }
      if (ignored.length) notes.push(`忽略 ${ignored.length} 个不触发套件的改动（文档 / 站点 / 脚本）`);
      if (picked.size === 0) notes.push('改动的文件都不触发套件，没有要跑的');
    }
    explicit++;
  }

  if (explicit === 0) {
    addAll('未指定选择器，默认全套');
  }
  return { picked, notes, all: false };
}

// ─────────────────────────────────────────────────────────── --list

if (flags.has('list')) {
  console.log('套件：');
  for (const k of SUITE_ORDER) {
    const s = map.suites[k];
    console.log(`  ${k.padEnd(9)} ${s.file.padEnd(22)} ~${String(s.estSeconds).padStart(3)}s  ${String(s.checks ?? '?').padStart(3)} 项  ${s.title}`);
    console.log(`  ${' '.repeat(9)} ${s.covers}`);
  }
  console.log('\n模块 → 套件：');
  for (const [k, m] of Object.entries(map.modules)) {
    console.log(`  ${k.padEnd(14)} → ${m.suites.join(', ')}`);
    console.log(`  ${' '.repeat(14)}   ${m.paths.join('  |  ')}`);
  }
  console.log('\n触发全套：');
  for (const p of map.fullRunTriggers?.paths || []) console.log(`  ${p}`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────── 选中结果

const sel = select();
let suites = sel.all
  ? [...SUITE_ORDER]
  : SUITE_ORDER.filter((s) => sel.picked.has(s));

const est = suites.reduce((n, s) => n + (map.suites[s].estSeconds || 0), 0);

if (flags.has('explain') || flags.has('dry-run')) {
  console.log(`套件目录：${suitesDir}`);
  console.log(`数据源  ：${isReal ? '真坚果云（USE_REAL_DAV=1）' : 'mock（同源假 DAV）'}`);
  if (sel.all) console.log(`选中原因：${sel.allWhy}`);
  if (sel.changed) console.log(`改动文件：${sel.changed.join(', ')}`);
  for (const n of sel.notes) console.log(`提示    ：${n}`);
  console.log(`\n将跑 ${suites.length} 套（预估 ${est}s）：`);
  for (const s of suites) {
    const why = sel.all ? sel.allWhy : [...(sel.picked.get(s) || [])].join(' / ');
    console.log(`  ${s.padEnd(9)} ${map.suites[s].file.padEnd(22)} ${why}`);
  }
  if (est > 120 && suites.length > 1) {
    console.log(`\n⚠ 预估超过 2 分钟，确认选择器是否够窄（--suites= / --module=）`);
  }
  process.exit(0);
}

if (suites.length === 0) {
  console.log('没有需要跑的套件。');
  for (const n of sel.notes) console.log(`  ${n}`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────── 执行

const tag = isReal ? 'real' : 'mock';
const logName = (file) => path.join(logDir, `${tag}-${file}.log`);

function spawnSuite(file, env, timeoutMs) {
  return new Promise((resolve) => {
    const outStream = fs.createWriteStream(logName(file));
    const child = spawn(process.execPath, [file], {
      cwd: suitesDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pass = 0;
    let fail = 0;
    let timedOut = false;
    let tail = '';
    let carry = '';
    const eat = (buf) => {
      const text = buf.toString('utf8');
      outStream.write(text);
      const parts = (carry + text).split(/\r?\n/);
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (/^PASS\b/.test(line)) pass++;
        else if (/^FAIL\b/.test(line)) {
          fail++;
          if (fail <= 6) tail += `${line}\n`;
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', eat);
    child.stderr.on('data', eat);
    child.on('error', (err) => {
      clearTimeout(timer);
      outStream.end();
      resolve({ code: -1, pass, fail, timedOut, tail: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      outStream.end();
      resolve({ code, pass, fail, timedOut, tail });
    });
  });
}

const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));

(async () => {
  const alive = await fetch(base + '/', { signal: AbortSignal.timeout(4000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!alive) {
    console.error(`dev server 不可用（${base}）。先跑：pnpm --filter @donote/web dev`);
    process.exit(2);
  }

  const env = { ...process.env, BASE: base };
  if (nodePath) env.NODE_PATH = nodePath;
  if (local.account) env.DONOTE_ACCOUNT = local.account;
  if (local.secretsFile) env.DONOTE_SECRETS = local.secretsFile;
  if (local.artifactsDir) env.DONOTE_ARTIFACTS_DIR = path.resolve(REPO, local.artifactsDir);
  if (isReal) env.USE_REAL_DAV = '1';
  else delete env.USE_REAL_DAV;

  console.log(`模式 ${tag}｜套件目录 ${suitesDir}｜BASE ${base}`);
  fs.mkdirSync(logDir, { recursive: true });
  if (isReal) console.log('⚠ 真实坚果云：免费版 600 请求 / 30 分钟，只该在发版前跑');
  if (sel.all) console.log(`选中原因：${sel.allWhy}`);
  if (sel.changed) console.log(`改动文件：${sel.changed.join(', ')}`);
  for (const n of sel.notes) console.log(`提示：${n}`);
  console.log('');

  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < suites.length; i++) {
    const s = suites[i];
    const file = map.suites[s].file;
    const expected = Number(map.suites[s].checks) || 0;
    const s0 = Date.now();
    const r = await spawnSuite(file, env, timeoutSec * 1000);
    const secs = Math.round((Date.now() - s0) / 1000);
    const ran = r.pass + r.fail;
    const missing = expected ? Math.max(0, expected - ran) : 0;
    const extra = expected && ran > expected ? ran - expected : 0;
    const incomplete = missing > 0;
    // 未跑完 / 非正常退出都算坏：只数 PASS/FAIL 会把崩在半路的套件看成全绿
    const bad = r.fail > 0 || r.pass === 0 || r.timedOut || r.code !== 0 || incomplete;
    results.push({ suite: s, file, secs, expected, ran, missing, extra, incomplete, ...r, bad });
    const counts = expected ? `  ${String(ran).padStart(3)}/${expected} 项` : '';
    console.log(
      `${r.timedOut ? '⏱' : bad ? '✗' : '✓'} ${file.padEnd(22)} ` +
        `exit=${String(r.code).padEnd(4)} ${String(secs).padStart(4)}s  PASS=${String(r.pass).padStart(3)} FAIL=${r.fail}${counts}`,
    );
    if (bad) {
      if (r.timedOut) console.log(`    ⏱ 超过 ${timeoutSec}s 被强杀，日志 ${logName(file)}`);
      else if (r.pass === 0) console.log(`    0 项断言，日志 ${logName(file)}`);
      else if (incomplete) {
        console.log(`    ✗ 未跑完：只执行 ${ran}/${expected} 项、缺 ${missing} 项（exit=${r.code}），日志 ${logName(file)}`);
      } else if (r.code !== 0) console.log(`    ✗ 进程非正常退出 exit=${r.code}（断言 0 失败，日志 ${logName(file)}）`);
      if (r.tail) for (const line of r.tail.trimEnd().split('\n')) console.log(`    ${line}`);
    } else if (extra) {
      console.log(`    ⚠ 比映射表记的 ${expected} 项多出 ${extra} 项（套件改了，记得更新 regression-map.json 的 checks）`);
    }
    if (gapSec > 0 && i < suites.length - 1) {
      console.log(`    …停 ${gapSec}s（真实模式避限流）`);
      await sleep(gapSec);
    }
  }
  const totalSec = Math.round((Date.now() - t0) / 1000);

  const totalPass = results.reduce((n, r) => n + r.pass, 0);
  const totalFail = results.reduce((n, r) => n + r.fail, 0);
  const totalMissing = results.reduce((n, r) => n + r.missing, 0);
  const broken = results.filter((r) => r.bad);
  /** 汇总里的 FAIL：断言失败 + 没跑到的项（缺的项按 FAIL 计，否则崩在半路会被当成全绿） */
  const failLike = totalFail + totalMissing;

  const reasonOf = (r) => {
    if (r.timedOut) return `超时（>${timeoutSec}s）`;
    if (r.pass === 0) return '无输出';
    if (r.incomplete) return `未跑完 ${r.ran}/${r.expected}（缺 ${r.missing} 项）`;
    if (r.code !== 0) return `进程 exit=${r.code}`;
    return `FAIL ${r.fail}`;
  };

  if (flags.has('json')) {
    console.log(
      JSON.stringify(
        {
          mode: tag,
          base,
          suites: results.map(({ suite, file, secs, code, pass, fail, expected, ran, missing, incomplete, timedOut, bad }) => ({ suite, file, secs, code, pass, fail, expected, ran, missing, incomplete, timedOut, bad })),
          totalPass,
          totalFail,
          totalMissing,
          failLike,
          totalSec,
          ok: broken.length === 0,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\n──────────────────────────────');
    console.log(
      `${suites.length} 套｜PASS ${totalPass}｜FAIL ${failLike}` +
        (totalMissing ? `（断言失败 ${totalFail} ＋ 未执行 ${totalMissing}）` : '') +
        `｜用时 ${totalSec}s（预估 ${est}s）`,
    );
    if (broken.length) {
      console.log(`\n✗ 本次不算全绿，有问题的套件：`);
      for (const r of broken) console.log(`  ${r.file.padEnd(22)} ${reasonOf(r)}  日志 ${logName(r.file)}`);
    } else {
      console.log('全绿' + (isReal ? '' : '（mock 全绿 = 逻辑回归通过；发版前还要跑一次 --real）'));
    }
  }

  process.exit(broken.length ? 1 : 0);
})();
