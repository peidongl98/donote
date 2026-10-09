/**
 * 把 tauri build 的产物铺进下载站，并生成应用内更新用的清单。
 *
 *   node scripts/make-release.mjs [--version 0.1.0] [--notes "更新说明"]
 *
 * 产物约定（site/ 就是 Cloudflare Pages 的发布目录）：
 *   site/downloads/DoNote-<version>-win-x64.exe   给用户手动下载，同时也给应用内更新用
 *   site/updates/latest.json                      更新清单，签名直接内联
 *
 * 清单里的 URL 必须与站点根路径一致；签名是 tauri 生成的 .sig 文件内容（minisign 文本）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const bundleDir = join(repo, 'apps/desktop/src-tauri/target/release/bundle/nsis');
const siteDir = join(repo, 'site');

const SITE_ORIGIN = 'https://donote.pages.dev';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);
const notes = arg('notes', `DoNote ${version}`);

const setupName = `DoNote_${version}_x64-setup.exe`;
const setupPath = join(bundleDir, setupName);
const sigPath = `${setupPath}.sig`;

for (const file of [setupPath, sigPath]) {
  if (!existsSync(file)) {
    console.error(`缺少打包产物：${file}`);
    console.error('先跑：cd apps/desktop && pnpm tauri build --bundles nsis');
    process.exit(1);
  }
}

const downloadName = `DoNote-${version}-win-x64.exe`;
const downloadDir = join(siteDir, 'downloads');
const updatesDir = join(siteDir, 'updates');
mkdirSync(downloadDir, { recursive: true });
mkdirSync(updatesDir, { recursive: true });

copyFileSync(setupPath, join(downloadDir, downloadName));

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sigPath, 'utf8').trim(),
      url: `${SITE_ORIGIN}/downloads/${downloadName}`,
    },
  },
};

writeFileSync(join(updatesDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`安装包  → site/downloads/${downloadName}`);
console.log(`更新清单 → site/updates/latest.json（版本 ${version}）`);
