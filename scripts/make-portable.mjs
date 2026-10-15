/**
 * 生成绿色版（免安装）压缩包。
 *
 *   node scripts/make-portable.mjs [--version 0.3.0]
 *
 * 产物：site/downloads/DoNote-<version>-win-x64-portable.zip
 *   DoNote/donote.exe      release 构建的可执行文件
 *   DoNote/portable.txt    绿色版标记（程序靠它把数据目录挪到解压目录下）
 *   DoNote/使用说明.txt
 *
 * 绿色版和安装版共用同一个 exe：有没有 portable.txt 决定数据放哪
 * （见 apps/desktop/src-tauri/src/lib.rs 的 portable_root）。
 *
 * zip 由脚本自己写（只用 Node 内置的 zlib）—— Windows 上不依赖任何压缩工具，
 * 也不引第三方依赖，和 release.mjs 的「只用内置模块」保持一致。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);

const exePath = join(repo, 'apps/desktop/src-tauri/target/release/donote.exe');
if (!existsSync(exePath)) {
  console.error(`缺少打包产物：${exePath}`);
  console.error('先跑：cd apps/desktop && pnpm tauri build --bundles nsis');
  process.exit(1);
}

const MARK = `这个文件是 DoNote 绿色版（免安装）的标记。有这个文件时，界面数据与笔记缓存都留在本目录下，不写系统盘。
删掉它，程序会改用安装版的位置存放数据（%LOCALAPPDATA%）。不需要绿色版就直接删。
`;

const README = `DoNote 绿色版（免安装）v${version}
================================

怎么用
  把整个 DoNote 文件夹放到你想放的位置（U 盘也行），双击 donote.exe 就能用。

它和安装版的区别
  · 不用安装，不写注册表，不用了就删掉这个文件夹。
  · 连接配置、笔记缓存、界面数据都在本目录的 data\\ 里（portable.txt 是标记文件，别删）。
  · 绿色版不带自动更新：有新版本到 https://donote.pages.dev 下载新的绿色包，
    把新的 donote.exe 覆盖过去即可，data\\ 里的配置不受影响。

几件要提前知道的事
  · 笔记不在本机：它一直存在你自己填的坚果云里，这个文件夹只是缓存和连接配置。
  · 连接密码存在 Windows 凭据管理器（服务名 donote），换一台电脑要重新填一次。
  · 首次运行如果 Windows 提示「未知发布者」，点「更多信息 → 仍要运行」。

想要开始菜单快捷方式和应用内更新，请下载安装包版本。
`;

// ─────────────────────────────────────────────────── 最小 zip 写入

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳（zip 用的是 1980 纪元的 16 位时间/日期） */
function dosStamp(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** entries: [{ name, data }] → zip 字节 */
function makeZip(entries) {
  const stamp = dosStamp(new Date());
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const body = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 需要的解压版本
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(stamp.time, 12);
    head.writeUInt16LE(stamp.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通文件 rw-r--r--
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, end]);
}

// ─────────────────────────────────────────────────── 输出

const zipName = `DoNote-${version}-win-x64-portable.zip`;
const outDir = join(repo, 'site/downloads');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, zipName);

const exe = readFileSync(exePath);
writeFileSync(
  outPath,
  makeZip([
    { name: 'DoNote/donote.exe', data: exe },
    { name: 'DoNote/portable.txt', data: Buffer.from(MARK, 'utf8') },
    { name: 'DoNote/使用说明.txt', data: Buffer.from(README, 'utf8') },
  ]),
);

console.log(`绿色版  → site/downloads/${zipName}`);
console.log(`  内含 ${statSync(exePath).size} 字节的 donote.exe ＋ portable.txt ＋ 使用说明.txt`);
