#!/usr/bin/env node
/**
 * DoNote 一键发版。
 *
 *   pnpm release 0.2.5
 *   pnpm release 0.2.5 --notes "这次改了…"
 *   node scripts/release.mjs 0.2.5 --dry-run      # 只打印计划，什么都不做
 *
 * 七步，任一步失败就停下并报告「已完成的步骤 + 怎么收尾」：
 *   1 改版本号（7 处）        5 提交
 *   2 打包（tauri build）      6 推送（GitHub Git Data API）
 *   3 生成发布产物             7 线上核验
 *   4 部署（Cloudflare Pages）
 *
 * 为什么不用 git push：本机对 github.com:443 直连被阻断，会弹凭据管理器挂死。
 * 为什么推送要放在提交之后：push-to-github.cjs 推的是 git ls-files 的镜像。
 *
 * 只依赖 Node 内置模块。
 */
'use strict';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────── 常量 / 参数

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://donote.pages.dev';
const PAGES_PROJECT = 'donote';
const PAGES_BRANCH = 'main';
const IS_WINDOWS = process.platform === 'win32';

const SECRETS_FILE = process.env.DONOTE_SECRETS || 'D:/design-website/.deploy-secrets';
const BUNDLE_DIR = join(REPO, 'apps/desktop/src-tauri/target/release/bundle/nsis');

/**
 * 单安装点基线 —— 一台机器只允许装出**一个** DoNote。
 *   · 打包目标只有 nsis：多出一种（例如 MSI 与 NSIS 并存）会在
 *     `%LOCALAPPDATA%\DoNote` 与 `C:\Program Files\DoNote` 各留一份；
 *   · installMode 只有 currentUser：perMachine 或 both 会让安装目录随权限漂移；
 *   · identifier / productName 固定：改了等于换了一个应用，旧的那份不会被就地升级覆盖。
 * 这三条一旦漂移，是全量用户都会中招的系统性问题 —— 所以每次发版都自动拦一道，
 * 不靠记性。要改基线，先确认老用户仍会被就地升级（同目录覆盖）。
 */
const EXPECT_BUNDLE_TARGETS = ['nsis'];
const EXPECT_INSTALL_MODE = 'currentUser';
const EXPECT_IDENTIFIER = 'com.donote.desktop';
const EXPECT_PRODUCT_NAME = 'DoNote';
/**
 * 更新时沿用上次安装位置的钩子。
 * 手动安装时用户能自选目录，而自动更新走 /P 会跳过该页并落回默认位置 ——
 * 没有这个钩子，自选过目录的用户更新后就会在默认位置多出一份安装。
 */
const EXPECT_INSTALLER_HOOKS = './windows/installer-hooks.nsi';
const TAURI_JS = join(REPO, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');

/** 本机托管目录里的 wrangler（仓库没把它列为依赖）。可用 DONOTE_WRANGLER 覆盖。 */
const DEFAULT_WRANGLER =
  'C:/Users/l5353/.workbuddy/binaries/node/workspace/node_modules/.bin/wrangler';

/** 取值型开关：`--notes x` 与 `--notes=x` 都认 */
const VALUE_FLAGS = new Set(['version', 'notes']);

const RAW_ARGS = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positionals = [];
for (let i = 0; i < RAW_ARGS.length; i++) {
  const a = RAW_ARGS[i];
  if (!a.startsWith('--')) {
    positionals.push(a);
    continue;
  }
  const eq = a.indexOf('=');
  if (eq >= 0) {
    opts[a.slice(2, eq)] = a.slice(eq + 1);
    continue;
  }
  const key = a.slice(2);
  if (VALUE_FLAGS.has(key) && RAW_ARGS[i + 1] !== undefined && !RAW_ARGS[i + 1].startsWith('--')) {
    opts[key] = RAW_ARGS[++i];
    continue;
  }
  flags.add(key);
}

const TARGET = positionals[0] || opts.version || '';
const NOTES = opts.notes || '';
const DRY = flags.has('dry-run');
const SKIP = {
  build: flags.has('skip-build'),
  release: flags.has('skip-release'),
  deploy: flags.has('skip-deploy'),
  commit: flags.has('skip-commit'),
  push: flags.has('skip-push'),
  verify: flags.has('skip-verify'),
};
const ALLOW_DIRTY = flags.has('allow-dirty');
const ALLOW_BRANCH = flags.has('allow-branch');
const FORCE = flags.has('force');

const STEPS = ['版本号', '打包', '发布产物', '部署', '提交', '推送', '线上核验'];
let currentStep = null;
const done = [];

// ─────────────────────────────────────────────────────────── 输出 / 失败

const log = (...a) => console.log(...a);

function step(no, title) {
  currentStep = { no, title };
  log(`\n【${no}/7】${title}`);
}

function die(msg, hints = []) {
  console.error(`\n✗ 失败于第 ${currentStep?.no ?? '?'} 步（${currentStep?.title ?? '前置检查'}）：${msg}`);
  if (done.length) {
    console.error(`\n已完成的步骤：${done.join(' → ')}`);
  }
  if (hints.length) {
    console.error('\n收尾建议：');
    for (const h of hints) console.error(`  · ${h}`);
  }
  process.exit(1);
}

function run(cmd, args, { cwd = REPO, env = {}, capture = false, label } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    // 🔴 Windows 上 .cmd / .bat 不能直接被 CreateProcess 起（Node 会 EINVAL），必须过一层 shell
    shell: IS_WINDOWS && /[.]cmd$|[.]bat$/i.test(cmd),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) die(`${label || cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) {
    const tail = (r.stderr || '').toString().trim().split('\n').slice(-6).join('\n');
    die(`${label || `${cmd} ${args.join(' ')}`} 退出码 ${r.status}${tail ? `\n${tail}` : ''}`);
  }
  return (r.stdout || '').toString();
}

// ─────────────────────────────────────────────────────────── 环境探测

function readSecrets() {
  if (!existsSync(SECRETS_FILE)) die(`找不到凭据文件 ${SECRETS_FILE}`);
  const out = {};
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function findRustupBin() {
  if (process.env.DONOTE_RUSTUP_BIN) return process.env.DONOTE_RUSTUP_BIN;
  const base = join(homedir(), '.rustup', 'toolchains');
  if (!existsSync(base)) return null;
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  for (const d of readdirSync(base)) {
    const bin = join(base, d, 'bin');
    if (existsSync(join(bin, cargo))) return bin;
  }
  return null;
}

function findWrangler(secrets) {
  const raw = [
    process.env.DONOTE_WRANGLER,
    secrets.WRANGLER_BIN,
    join(REPO, 'node_modules/.bin/wrangler.cmd'),
    DEFAULT_WRANGLER,
  ].filter(Boolean);
  // 🔴 Windows 的 .bin 里同时躺着 POSIX sh 脚本（无后缀）和 .cmd。无后缀那个不是可执行文件，
  // 按顺序先取到它会直接 ENOENT（实测发布卡在这一步）。Windows 上一律优先取 .cmd/.exe。
  const candidates = IS_WINDOWS
    ? raw.flatMap((c) => (/\.(cmd|bat|exe)$/i.test(c) ? [c] : [`${c}.cmd`, c]))
    : raw;
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// ─────────────────────────────────────────────────────────── 单安装点基线

/** 配置层：打包配置有没有漂移（发版前先跑，改错了立刻停，别等装出来才发现） */
function assertSingleInstallPoint(phase) {
  const conf = JSON.parse(readFileSync(join(REPO, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const problems = [];
  const targets = conf.bundle?.targets ?? [];
  if (targets.join(',') !== EXPECT_BUNDLE_TARGETS.join(',')) {
    problems.push(`bundle.targets 应为 ${JSON.stringify(EXPECT_BUNDLE_TARGETS)}，现在是 ${JSON.stringify(targets)}`);
  }
  const mode = conf.bundle?.windows?.nsis?.installMode;
  if (mode !== EXPECT_INSTALL_MODE) {
    problems.push(`nsis.installMode 应为 ${EXPECT_INSTALL_MODE}，现在是 ${mode ?? '（未设置）'}`);
  }
  if (conf.identifier !== EXPECT_IDENTIFIER) {
    problems.push(`identifier 应为 ${EXPECT_IDENTIFIER}，现在是 ${conf.identifier}`);
  }
  if (conf.productName !== EXPECT_PRODUCT_NAME) {
    problems.push(`productName 应为 ${EXPECT_PRODUCT_NAME}，现在是 ${conf.productName}`);
  }
  const hooks = conf.bundle?.windows?.nsis?.installerHooks;
  if (hooks !== EXPECT_INSTALLER_HOOKS) {
    problems.push(`nsis.installerHooks 应为 ${EXPECT_INSTALLER_HOOKS}，现在是 ${hooks ?? '（未配置）'}`);
  } else {
    const hookFile = resolve(join(REPO, 'apps/desktop/src-tauri'), hooks);
    if (!existsSync(hookFile)) {
      problems.push(`钩子文件不存在：${hooks}`);
    } else if (!readFileSync(hookFile, 'utf8').includes('NSIS_HOOK_PREINSTALL')) {
      problems.push(`钩子里没有 NSIS_HOOK_PREINSTALL 宏：${hooks}`);
    }
  }
  if (problems.length) {
    die(`${phase}单安装点检查不通过：\n  - ${problems.join('\n  - ')}`, [
      '多种产物 / perMachine 会让同一台机器出现两个安装目录，全量用户都会中招',
      '确实要改，先确认老用户仍会被就地升级（同目录覆盖），再更新基线并在提交里写清理由',
    ]);
  }
  log(`  ✓ 单安装点：${EXPECT_BUNDLE_TARGETS.join('/')} · ${EXPECT_INSTALL_MODE} · ${EXPECT_IDENTIFIER} · ${EXPECT_PRODUCT_NAME} · 更新沿用原安装位置`);
}

/** 磁盘层：bundle 目录里有没有冒出基线之外的类型（打包后查） */
function assertBundleDirsClean() {
  const root = join(REPO, 'apps/desktop/src-tauri/target/release/bundle');
  if (!existsSync(root)) return;
  const kinds = readdirSync(root).filter((n) => {
    try {
      return statSync(join(root, n)).isDirectory();
    } catch {
      return false;
    }
  });
  const extra = kinds.filter((k) => !EXPECT_BUNDLE_TARGETS.includes(k));
  if (extra.length) {
    die(`产物目录里出现了基线之外的类型：${extra.join('、')}`, [
      `删掉 ${join(root, extra[0])} 再重跑 —— 它不该被打包出来`,
    ]);
  }
  log(`  ✓ 产物目录只有 ${kinds.join('/') || '（空）'}`);
}

// ─────────────────────────────────────────────────────────── 步骤 1：版本号

/** 7 处版本号。返回实际改动的文件列表（没改到的会报出来）。 */
function bumpVersions(oldV, newV) {
  const targets = [
    { file: 'package.json', kind: 'json-v' },
    { file: 'apps/desktop/package.json', kind: 'json-v' },
    { file: 'apps/web/package.json', kind: 'json-v' },
    { file: 'packages/shared/package.json', kind: 'json-v' },
    { file: 'apps/desktop/src-tauri/tauri.conf.json', kind: 'json-v' },
    { file: 'apps/desktop/src-tauri/Cargo.toml', kind: 'cargo' },
    { file: 'site/index.html', kind: 'site-exe' },
  ];
  const changed = [];
  const missed = [];
  for (const t of targets) {
    const abs = join(REPO, t.file);
    if (!existsSync(abs)) {
      missed.push(`${t.file}（文件不存在）`);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    let out = src;
    if (t.kind === 'json-v') out = src.replace(`"version": "${oldV}"`, `"version": "${newV}"`);
    if (t.kind === 'cargo') out = src.replace(`\nversion = "${oldV}"`, `\nversion = "${newV}"`);
    if (t.kind === 'site-exe') out = src.replaceAll(`DoNote-${oldV}-win-x64.exe`, `DoNote-${newV}-win-x64.exe`);
    if (out === src) {
      missed.push(`${t.file}（没找到 "${oldV}"）`);
      continue;
    }
    writeFileSync(abs, out, 'utf8');
    changed.push(t.file);
  }
  for (const f of changed) log(`  ✓ ${f}`);
  if (missed.length) {
    die(
      `有 ${missed.length} 处没改到：\n  - ${missed.join('\n  - ')}`,
      ['先 git restore 还原已改的文件，再核对该位置的版本号写法'],
    );
  }
  return changed;
}

// ─────────────────────────────────────────────────────────── 步骤 7：线上核验

async function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function verifyLive(newV, oldV) {
  const bust = `?v=${Date.now()}`;
  const problems = [];

  const manifest = await fetch(`${SITE_ORIGIN}/updates/latest.json${bust}`).then((r) => r.json());
  if (manifest.version !== newV) problems.push(`latest.json 版本是 ${manifest.version}，期望 ${newV}`);
  // 更新清单只允许一条平台：多出 mac/linux 之类会指向别的安装器，Windows 用户可能装出第二处
  const plats = Object.keys(manifest.platforms ?? {});
  if (plats.join(',') !== 'windows-x86_64') {
    problems.push(`更新清单里的平台应只有 windows-x86_64，现在是 ${plats.join('、') || '（空）'}`);
  }
  const url = manifest.platforms?.['windows-x86_64']?.url || '';
  if (!url.includes(`DoNote-${newV}-win-x64.exe`)) problems.push(`清单里的下载地址不对：${url}`);
  log(`  更新清单版本 ${manifest.version}｜签名 ${(manifest.platforms?.['windows-x86_64']?.signature || '').slice(0, 24)}…`);

  const local = readFileSync(join(REPO, 'site/downloads', `DoNote-${newV}-win-x64.exe`));
  const head = await fetch(`${SITE_ORIGIN}/downloads/DoNote-${newV}-win-x64.exe${bust}`, { method: 'HEAD' });
  if (head.status !== 200) problems.push(`安装包 HEAD 返回 ${head.status}`);
  const remote = Buffer.from(await (await fetch(`${SITE_ORIGIN}/downloads/DoNote-${newV}-win-x64.exe${bust}`)).arrayBuffer());
  const a = await sha256Of(local);
  const b = await sha256Of(remote);
  log(`  安装包 HTTP ${head.status}｜本地 ${a.slice(0, 16)}…｜线上 ${b.slice(0, 16)}…`);
  if (a !== b) problems.push('线上安装包与本地 sha256 不一致');

  const prev = await fetch(`${SITE_ORIGIN}/downloads/DoNote-${oldV}-win-x64.exe`, { method: 'HEAD' });
  if (prev.status !== 200) problems.push(`上一版 ${oldV} 下载失效（HTTP ${prev.status}）`);
  else log(`  上一版 ${oldV} 仍可下载（HTTP 200）`);

  if (problems.length) die(`线上核验不通过：\n  - ${problems.join('\n  - ')}`, ['用 --skip-verify 跳过，或先排查 Pages 部署']);
  return { sha256: a, url };
}

// ─────────────────────────────────────────────────────────── 主流程

(async () => {
  if (!TARGET) {
    console.error('用法：pnpm release <新版本号> [--notes "更新说明"] [--dry-run]');
    process.exit(2);
  }
  if (!/^\d+\.\d+\.\d+$/.test(TARGET)) die(`版本号格式不对：${TARGET}（期望 x.y.z）`);

  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const currentV = pkg.version;
  const cmp = (a, b) => {
    const [x, y, z] = a.split('.').map(Number);
    const [p, q, r] = b.split('.').map(Number);
    return x - p || y - q || z - r;
  };
  if (cmp(TARGET, currentV) <= 0 && !FORCE) {
    die(`新版本号 ${TARGET} 不大于当前 ${currentV}（要强推加 --force）`);
  }

  log(`DoNote 发版：${currentV} → ${TARGET}${DRY ? '（dry-run，不会改任何东西）' : ''}`);
  log(`仓库 ${REPO}`);

  // 前置检查
  const secrets = readSecrets();
  for (const k of ['GITHUB_TOKEN', 'CLOUDFLARE_Page_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (!secrets[k]) die(`凭据文件里没有 ${k}`);
  }
  const rustupBin = findRustupBin();
  if (!rustupBin) die('找不到 rustup toolchain 的 bin 目录（可用 DONOTE_RUSTUP_BIN 指定）');
  if (!existsSync(TAURI_JS)) die(`找不到 tauri CLI：${TAURI_JS}（先 pnpm install）`);
  const wrangler = findWrangler(secrets);
  if (!wrangler) die('找不到 wrangler', [`设环境变量 DONOTE_WRANGLER=<wrangler 路径>`, `或在 ${SECRETS_FILE} 里加一行 WRANGLER_BIN=`]);

  const head = readFileSync(join(REPO, '.git/HEAD'), 'utf8').trim();
  const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  if (branch !== 'main' && !ALLOW_BRANCH) die(`当前分支是 ${branch ?? '（游离 HEAD）'}，不是 main（要放行加 --allow-branch）`);
  const dirty = run('git', ['status', '--porcelain'], { capture: true }).trim();
  if (dirty && !ALLOW_DIRTY) {
    die(`工作区不干净，先提交或还原：\n${dirty}`, ['确要带着改动发版，加 --allow-dirty']);
  }
  log(`  cargo   ${rustupBin}`);
  log(`  wrangler ${wrangler}`);
  log(`  凭据    ${SECRETS_FILE}（GITHUB_TOKEN / CLOUDFLARE_*）`);
  assertSingleInstallPoint('发版前');

  const plan = [
    `1 版本号 ${currentV} → ${TARGET}（7 处）`,
    `2 打包 pnpm tauri build --bundles nsis`,
    `3 生成发布产物（site/downloads + site/updates/latest.json）`,
    `4 部署 site/ → Cloudflare Pages（${PAGES_PROJECT} / ${PAGES_BRANCH}）`,
    `5 提交 chore(release): ${TARGET}`,
    `6 推送源码到 GitHub（Git Data API）`,
    `7 线上核验（latest.json / sha256 / 旧版仍可下）`,
  ];
  log('\n计划：');
  for (const p of plan) log(`  ${p}`);
  if (DRY) {
    log('\ndry-run 结束，没有做任何改动。');
    process.exit(0);
  }

  // 1 版本号
  step(1, '改版本号');
  bumpVersions(currentV, TARGET);
  done.push(STEPS[0]);

  // 2 打包
  step(2, '打包');
  if (SKIP.build) log('  （--skip-build 跳过）');
  else {
    const dist = join(REPO, 'apps/web/dist');
    if (existsSync(dist)) {
      const aside = join(REPO, 'apps/web/dist.before-release');
      rmSync(aside, { recursive: true, force: true });
      renameSync(dist, aside);
      log('  dist 已让开 → dist.before-release（构建后由 Vite 重建）');
    }
    log('  tauri build（约 3–4 分钟）…');
    run(process.execPath, [TAURI_JS, 'build', '--bundles', 'nsis'], {
      cwd: join(REPO, 'apps/desktop'),
      env: {
        PATH: `${rustupBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
        TAURI_SIGNING_PRIVATE_KEY: join(REPO, '.updater-key/donote.key'),
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      },
      label: 'tauri build',
    });
  }
  const setup = join(BUNDLE_DIR, `DoNote_${TARGET}_x64-setup.exe`);
  for (const f of [setup, `${setup}.sig`]) {
    if (!existsSync(f)) die(`打包产物缺失：${f}`, ['看上面的 tauri build 输出']);
  }
  log(`  ${statSync(setup).size} 字节  ${setup.replace(REPO, '.')}`);
  assertBundleDirsClean();
  done.push(STEPS[1]);

  // 3 发布产物
  step(3, '生成发布产物');
  if (SKIP.release) log('  （--skip-release 跳过）');
  else {
    run(process.execPath, ['scripts/make-release.mjs', '--version', TARGET, '--notes', NOTES || `DoNote ${TARGET}`], {
      label: 'make-release',
    });
  }
  const download = join(REPO, 'site/downloads', `DoNote-${TARGET}-win-x64.exe`);
  if (!existsSync(download)) die(`下载包缺失：${download}`);
  done.push(STEPS[2]);

  // 4 部署
  step(4, '部署到 Cloudflare Pages');
  if (SKIP.deploy) log('  （--skip-deploy 跳过）');
  else {
    const env = {
      CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_Page_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: secrets.CLOUDFLARE_ACCOUNT_ID,
      NO_PROXY: '127.0.0.1,localhost',
      // 本机代理会让 wrangler 连不上 Cloudflare；置空等于关掉
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      MSYS2_ARG_CONV_EXCL: '*',
    };
    run(wrangler, ['pages', 'deploy', 'site', '--project-name', PAGES_PROJECT, '--branch', PAGES_BRANCH], {
      env,
      label: 'wrangler pages deploy',
    });
  }
  done.push(STEPS[3]);

  // 5 提交
  step(5, '提交');
  const msgPath = join(tmpdir(), `donote-release-${TARGET}.txt`);
  writeFileSync(
    msgPath,
    `chore(release): ${TARGET}\n\n${NOTES || `DoNote ${TARGET}`}\n`,
    'utf8',
  );
  if (SKIP.commit) log('  （--skip-commit 跳过）');
  else {
    run('git', ['add', '-u'], { label: 'git add' });
    const staged = run('git', ['diff', '--cached', '--name-only'], { capture: true }).trim();
    log(`  暂存：${staged.split('\n').filter(Boolean).length} 个文件`);
    run('git', ['commit', '-F', msgPath], { label: 'git commit' });
  }
  done.push(STEPS[4]);

  // 6 推送
  step(6, '推送到 GitHub');
  if (SKIP.push) log('  （--skip-push 跳过）');
  else {
    const listPath = join(tmpdir(), `donote-release-${TARGET}-files.txt`);
    const list = run('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '-z'], { capture: true });
    writeFileSync(listPath, list, 'utf8');
    log(`  待推文件数 ${list.split('\0').filter(Boolean).length}`);
    run(process.execPath, ['scripts/push-to-github.cjs'], {
      env: {
        GITHUB_TOKEN: secrets.GITHUB_TOKEN,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        PUSH_FILE_LIST: listPath,
        PUSH_COMMIT_MSG_FILE: msgPath,
        NO_PROXY: '127.0.0.1,localhost',
      },
      label: 'push-to-github',
    });
  }
  done.push(STEPS[5]);

  // 7 线上核验
  step(7, '线上核验');
  let result = null;
  if (SKIP.verify) log('  （--skip-verify 跳过）');
  else result = await verifyLive(TARGET, currentV);
  done.push(STEPS[6]);

  log(`\n✓ 发版完成：${currentV} → ${TARGET}`);
  log(`  安装包   site/downloads/DoNote-${TARGET}-win-x64.exe（${statSync(download).size} 字节）`);
  if (result) log(`  sha256   ${result.sha256}`);
  log(`  下载     ${result?.url || `${SITE_ORIGIN}/downloads/DoNote-${TARGET}-win-x64.exe`}`);
  log(`  更新清单 ${SITE_ORIGIN}/updates/latest.json`);
  log('\n⚠ 别忘了：发布前应已跑过 node scripts/regression/run-regression.cjs --real（真机验收）。');
})().catch((err) => die(err.stack || String(err)));
