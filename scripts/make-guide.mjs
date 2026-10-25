#!/usr/bin/env node
/**
 * 把《配置说明》的 HTML 打成 PDF，放进安装包要带的那一层。
 *
 *   node scripts/make-guide.mjs
 *
 * 为什么要这一步而不是手放一个 PDF：说明书会跟着配置方式改（新增 NAS 品牌、报错对照），
 * 每次改完重跑一次就同步，不用记「PDF 是哪个版本」。
 *
 * 打印走 playwright-core 驱动本机的 Edge：
 * 直接命令行 `msedge --headless --print-to-pdf` 在这台机器上不出文件（已经有一个 Edge 在跑，
 * 新进程立刻退出、什么也不打印），换成由 playwright 自己拉起实例就稳。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'docs/guide/配置说明.html');
const OUT = path.join(ROOT, 'apps/desktop/src-tauri/resources/DoNote-Guide.pdf');

/** playwright-core 可能装在几个地方（仓库没把它列为依赖，回归套件也是外挂的） */
const CANDIDATES = [
  process.env.NODE_PATH,
  'C:/Users/l5353/.workbuddy/binaries/node/workspace/node_modules',
  path.join(ROOT, 'node_modules'),
  path.join(ROOT, '..', 'node_modules'),
].filter(Boolean);

async function loadPlaywright() {
  for (const base of CANDIDATES) {
    const entry = path.join(base, 'playwright-core', 'index.js');
    if (existsSync(entry)) {
      const mod = await import(pathToFileURL(entry).href);
      // CJS 入口被当成默认导出，具名导出不一定有
      return mod.chromium ?? mod.default?.chromium ?? mod.default;
    }
  }
  throw new Error('找不到 playwright-core，请设 NODE_PATH');
}

if (!existsSync(SRC)) {
  console.error(`找不到说明书源文件：${SRC}`);
  process.exit(1);
}
mkdirSync(path.dirname(OUT), { recursive: true });

const chromium = await loadPlaywright();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '15mm', right: '15mm' },
  });
} finally {
  await browser.close();
}

console.log(`✓ ${path.relative(ROOT, OUT)}（${(statSync(OUT).size / 1024).toFixed(0)} KB）`);
