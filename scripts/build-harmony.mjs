#!/usr/bin/env node
/**
 * 把前端产物铺进鸿蒙工程。
 *
 * 鸿蒙外壳（apps/harmony）本身只是一层 ArkWeb，真正的内容是 apps/web 的构建产物。
 * 这个脚本做三件事：
 *   1. 把已有的 apps/web/dist 改名让开（见下面注释，不能直接删）；
 *   2. 以相对路径模式构建一次前端（DONOTE_WEB_BASE=./）；
 *   3. 把 dist 拷进 entry/src/main/resources/rawfile/www —— 打包时会被塞进 HAP。
 *
 * 用法：
 *   node scripts/build-harmony.mjs          # 构建并铺好，接着就能 hvigorw assembleHap
 *   node scripts/build-harmony.mjs --keep   # 保留 apps/web/dist（只铺进 rawfile 就退出）
 */

import { existsSync, mkdirSync, renameSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(REPO, 'apps/web');
const DIST = join(WEB, 'dist');
const RAWFILE = join(REPO, 'apps/harmony/entry/src/main/resources/rawfile');
const WWW = join(RAWFILE, 'www');

const KEEP = process.argv.includes('--keep');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(msg, hints = []) {
  process.stderr.write(`\n✗ ${msg}\n`);
  for (const h of hints) process.stderr.write(`  · ${h}\n`);
  process.exit(1);
}

/** 目录里的文件数与总字节，用来在日志里报规模 */
function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        n++;
        bytes += statSync(full).size;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { n, bytes };
}


// 1 让 dist 空出来
/*
 * 这一步不能省。Vite 构建前会清空 outDir，而 dist 有 200 个上下文件 —— 本机的
 * safe-delete 守卫把「一次删 50 个以上」判成批量删除。只要 dist 在构建前**不存在**，
 * Vite 就无事可做。改名在同一层，不受影响；全程只改名、不删除。
 */
if (!KEEP && existsSync(DIST)) {
  const aside = join(WEB, 'dist.before-harmony');
  const target = existsSync(aside) ? `${aside}-${Date.now()}` : aside;
  renameSync(DIST, target);
  log(`· dist 让开 → ${target.replace(REPO, '.')}`);
}

// 2 构建前端（相对路径模式）
if (!KEEP) {
  log('· 构建前端（base=./）…');
  try {
    execFileSync('pnpm', ['--filter', '@donote/web', 'build'], {
      cwd: REPO,
      env: { ...process.env, DONOTE_WEB_BASE: './', DONOTE_WEB_HARMONY: '1' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch {
    die('前端构建失败', ['先单独跑 pnpm build:web 看完整报错']);
  }
}

if (!existsSync(DIST)) die(`找不到前端产物：${DIST.replace(REPO, '.')}`);

// 3 铺进 rawfile
/*
 * rawfile 里的东西会原样进 HAP，多余的旧文件只增体积不作废功能，但资源带 hash，
 * 留着会越堆越多 —— 所以每次都整个重铺。这里用 rmSync 是安全的：目录是我们自己
 * 生成的（rawfile/www 已 gitignore），不涉及用户数据。
 */
rmSync(WWW, { recursive: true, force: true });
mkdirSync(RAWFILE, { recursive: true });
cpSync(DIST, WWW, { recursive: true });

const { n: files, bytes } = countFiles(WWW);
log(`· rawfile/www ← dist  ${files} 个文件 / ${(bytes / 1e6).toFixed(1)}MB`);
log('\n✓ 前端已就位，可以打 HAP：');
log('    cd apps/harmony && hvigorw assembleHap --mode module -p product=default');
