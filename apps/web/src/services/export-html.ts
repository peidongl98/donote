/**
 * 单篇导出 HTML：一个文件、双击就能看，不依赖原目录。
 *
 * 三件事：
 * 1. Markdown → HTML，用 markdown-it（与 `MarkdownView` 同一套配置，所见即所得）
 * 2. 正文里的相对图片引用 → 去附件目录读原始字节 → `data:` URI 内嵌
 * 3. CSS 内联（随系统亮暗切换）
 *
 * 🔴 只能导出**单篇**：跨笔记的目录结构依赖 index.md 模型，本批次不做（任务书明确排除）。
 * 图片读不到（比如附件目录被挪走了）时保留原引用，不静默丢图 —— 导出完会回报张数。
 */
import MarkdownIt from 'markdown-it';
import { getStorage } from '@/services/storage';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

export interface ExportNote {
  /** 笔记在同步目录里的相对路径，用来定位附件 */
  path: string;
  title: string;
  /** 正文（不含 frontmatter） */
  content: string;
}

export interface ExportResult {
  html: string;
  /** 内嵌成功的图片数 */
  inlined: number;
  /** 读不到、仍留原引用的图片数 */
  missed: number;
}

/** 把正文字里的相对图片引用解析成同步目录里的绝对路径；外链 / 已经是 data: 的返回 null */
export function resolveAssetPath(notePath: string, src: string): string | null {
  if (/^(https?:|data:|blob:)/i.test(src)) return null;
  const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
  // 🔴 markdown-it 会把 URL 里的非 ASCII 做 percent-encoding，而同步目录里存的是原始文件名
  // （中文原样）。不解码的话 readBytes 一定 404 —— 实测第一次导出两张图全「没读到」。
  let clean = src.replace(/^\.\//, '');
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* 本来就不是合法编码，按原样用 */
  }
  if (!clean || clean.startsWith('/')) return null;
  return dir ? `${dir}/${clean}` : clean;
}

/** ArrayBuffer → base64（分块，别一次 apply 几十万个参数） */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function inlineImages(note: ExportNote, html: string): Promise<{ html: string; inlined: number; missed: number }> {
  const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(srcs)];
  let result = html;
  let inlined = 0;
  let missed = 0;

  for (const src of unique) {
    const path = resolveAssetPath(note.path, src);
    if (!path) continue; // 外链不动
    try {
      const bytes = await getStorage().readBytes(path);
      const ext = (path.split('.').pop() || '').toLowerCase();
      const mime = MIME[ext] ?? 'application/octet-stream';
      const dataUri = `data:${mime};base64,${toBase64(bytes)}`;
      result = result.split(`src="${src}"`).join(`src="${dataUri}"`);
      inlined += 1;
    } catch {
      missed += 1;
    }
  }
  return { html: result, inlined, missed };
}

/** 导出用的样式：跟应用里读起来一致，亮暗跟随系统 */
const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0 auto; padding: 48px 24px; max-width: 760px;
  font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #0f1419; background: #fff; word-break: break-word;
}
h1, h2, h3, h4 { line-height: 1.35; font-weight: 650; margin: 1.6em 0 .6em; }
h1 { font-size: 26px; } h2 { font-size: 21px; } h3 { font-size: 18px; }
p, ul, ol, blockquote, pre, table { margin: .9em 0; }
a { color: #4a6fa5; }
code { font-family: ui-monospace, Consolas, monospace; font-size: .92em;
  background: rgba(127,127,127,.14); padding: .15em .35em; border-radius: 4px; }
pre { background: rgba(127,127,127,.1); padding: 12px 14px; border-radius: 8px; overflow: auto; }
pre code { background: none; padding: 0; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid rgba(127,127,127,.35); color: #6b7280; }
table { border-collapse: separate; border-spacing: 0; width: 100%; border: 1px solid rgba(0,0,0,.06); border-radius: 8px; overflow: hidden; }
th, td { border-right: 1px solid rgba(0,0,0,.06); border-bottom: 1px solid rgba(0,0,0,.06); padding: 7px 11px; text-align: left; }
th { background: #f5f5f7; font-weight: 600; }
th:last-child, td:last-child { border-right: none; }
tr:last-child td, tr:last-child th { border-bottom: none; }
img { max-width: 100%; height: auto; border-radius: 8px; }
hr { border: none; border-top: 1px solid rgba(127,127,127,.3); margin: 1.8em 0; }
footer { margin-top: 56px; font-size: 12px; color: #8b96ad; }
@media (prefers-color-scheme: dark) {
  body { color: #e8ecf4; background: #0b1020; }
  code { background: rgba(255,255,255,.12); }
  pre { background: rgba(255,255,255,.07); }
  th { background: #1a2130; }
  th, td, table { border-color: rgba(255,255,255,.08); }
  blockquote { color: #8b96ad; }
  a { color: #7e9acd; }
  footer { color: #6b7280; }
}
`;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** 组装自包含 HTML（不写文件，方便先测） */
export async function buildExportHtml(note: ExportNote): Promise<ExportResult> {
  const body = md.render(note.content);
  const { html, inlined, missed } = await inlineImages(note, body);
  const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(note.title)}</title>
<style>${STYLE}</style>
</head>
<body>
${html}
<footer>由 DoNote 导出</footer>
</body>
</html>
`;
  return { html: doc, inlined, missed };
}

/** 落盘：桌面端走系统保存对话框，浏览器退化成下载 */
export async function saveExportHtml(fileName: string, html: string): Promise<'saved' | 'canceled'> {
  const { isTauriRuntime } = await import('@/storage/transport');
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const target = await save({ defaultPath: fileName, filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (typeof target !== 'string') return 'canceled';
    await invoke('write_text', { path: target, contents: html });
    return 'saved';
  }

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'saved';
}
