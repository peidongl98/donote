/**
 * Markdown → PDF（A4）。
 *
 * 路线：正文 → 内嵌图片的 HTML → 一份只给打印用的 A4 样式 → 交给系统打印对话框。
 *
 * 为什么不用 jsPDF / pdfmake 直接画：PDF 里的中文必须把整套字体嵌进去（十几 MB），
 * 而 Times New Roman 又不能随包分发；走打印链路用的是本机真字体（英文 Times New Roman、
 * 中文黑体），输出还是矢量文本 —— 能选中、能搜、放大会清晰。
 *
 * 代价：落盘那步由用户在打印对话框里点「另存为 PDF」，这是唯一不牺牲字体质量的走法。
 */
import { escapeHtml, renderNoteBody, type ExportNote } from './export-html';

/**
 * 打印样式。
 *
 * 字体只写名字不内嵌：浏览器按字形逐个回退 —— 拉丁字母用 Times New Roman，
 * 汉字用第一个装了的黑体（思源黑体优先，其次系统自带的黑体/雅黑）。
 */
const PRINT_STYLE = `
@page { size: A4; margin: 20mm 18mm; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body {
  font-family: "Times New Roman", "Source Han Sans SC", "Noto Sans CJK SC", "Source Han Sans CN",
    "Microsoft YaHei", SimHei, "PingFang SC", serif;
  font-size: 12pt; line-height: 1.7; word-break: break-word;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 { font-weight: 700; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 18pt; margin: 0 0 14pt; }
h2 { font-size: 16pt; margin: 18pt 0 10pt; }
h3 { font-size: 14pt; margin: 16pt 0 8pt; }
h4 { font-size: 12pt; margin: 14pt 0 6pt; }
h5, h6 { font-size: 12pt; margin: 12pt 0 6pt; }
p, ul, ol, blockquote, pre, table { margin: 0 0 10pt; }
ul, ol { padding-left: 2em; }
li { margin: 0 0 4pt; }
li > p { margin: 0; }
a { color: #000; text-decoration: underline; }
strong { font-weight: 700; }
code {
  font-family: Consolas, "Courier New", monospace; font-size: 10.5pt;
  background: #f2f2f2; padding: 0 2pt; border-radius: 2pt;
}
pre {
  background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 3pt;
  padding: 8pt 10pt; font-size: 10pt; line-height: 1.5;
  white-space: pre-wrap; page-break-inside: avoid; break-inside: avoid;
}
pre code { background: none; padding: 0; font-size: inherit; }
blockquote {
  margin-left: 0; padding: 2pt 0 2pt 12pt; border-left: 3pt solid #d0d0d0; color: #333;
}
table {
  border-collapse: collapse; width: 100%; font-size: 10.5pt;
  page-break-inside: avoid; break-inside: avoid;
}
th, td { border: 1px solid #999; padding: 5pt 7pt; text-align: left; vertical-align: top; }
th { background: #f2f2f2; font-weight: 700; }
img { max-width: 100%; height: auto; page-break-inside: avoid; break-inside: avoid; }
hr { border: none; border-top: 1px solid #bbb; margin: 14pt 0; }
`;

/** 组装只给打印用的 HTML（A4、浅色、无页脚） */
export async function buildPrintHtml(
  note: ExportNote,
): Promise<{ html: string; inlined: number; missed: number }> {
  const { body, inlined, missed } = await renderNoteBody(note);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(note.title)}</title>
<style>${PRINT_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return { html, inlined, missed };
}

/** 等图片解码完再打印，否则第二页以后会是空白 */
function waitForImages(doc: Document): Promise<void> {
  const pending = [...doc.images].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  ).then(() => undefined);
}

/**
 * 打开打印视图并唤起系统打印对话框（选「另存为 PDF」即得到 A4 PDF）。
 *
 * 用离屏 iframe 而不是新窗口：桌面端 WebView 里 `window.open` 未必出得来，
 * iframe 在浏览器和 WebView2 里行为一致，且只打印 iframe 自己那一份。
 */
export async function exportPdf(
  note: ExportNote,
): Promise<{ inlined: number; missed: number }> {
  const { html, inlined, missed } = await buildPrintHtml(note);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // 摆到屏幕外而不是 display:none —— 不可见的 iframe 打印出来是空白
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;';
  document.body.appendChild(frame);

  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) throw new Error('打印视图没能创建');
    doc.open();
    doc.write(html);
    doc.close();

    await waitForImages(doc);
    // 字体没就绪就打印，中文会先用后备字形，行宽会跳
    if (doc.fonts) await doc.fonts.ready.catch(() => undefined);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      window.setTimeout(() => frame.remove(), 800);
    };
    win.addEventListener('afterprint', cleanup, { once: true });
    win.focus();
    win.print();
    // 有的环境不派发 afterprint，十分钟后兜底收掉
    window.setTimeout(cleanup, 600000);
  } catch (error) {
    frame.remove();
    throw error;
  }
  return { inlined, missed };
}
