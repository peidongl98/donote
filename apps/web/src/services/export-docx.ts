/**
 * Markdown → Word（.docx）。
 *
 * 走的是**真的 docx**（`docx` 库直接拼 OOXML），不是把 HTML 塞进 .doc 再让 Word 猜：
 * 后者在 WPS / LibreOffice / 手机上排版会散，也不算「Word 文档」。
 *
 * 页面与字体按中文文档的习惯定：
 * - A4（210×297mm），四周 25.4mm 页边距，页脚居中页码
 * - 英文 Times New Roman，中文黑体（SimHei）—— Word 不支持字体回退列表，只能写一个名字，
 *   SimHei 是 Windows 必带的黑体；macOS 没有会退到系统默认中文字体
 * - 正文小四（12pt）、1.5 倍行距；标题按层级递减
 *
 * 图片：读附件原字节内嵌（不引用外部路径，换台机器打开也在）。Word 只吃 png/jpg/gif/bmp，
 * SVG / WebP 会留下来读不到的计数，导出后回报。
 */
import MarkdownIt from 'markdown-it';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip,
} from 'docx';
import type { ILevelsOptions, INumberingOptions } from 'docx';
import { getStorage } from '@/services/storage';
import { resolveAssetPath, type ExportNote } from './export-html';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * 字体。`eastAsia` 只对中文字符生效，`ascii/hAnsi` 管拉丁字母 ——
 * 这正是「英文 Times New Roman、中文黑体」在同一段里共存的做法。
 */
const FONT = {
  ascii: 'Times New Roman',
  hAnsi: 'Times New Roman',
  cs: 'Times New Roman',
  eastAsia: 'SimHei',
};
const MONO = { ascii: 'Consolas', hAnsi: 'Consolas', cs: 'Consolas', eastAsia: 'SimHei' };

/** 正文可用宽度（px，96dpi）：210 − 2×25.4 = 159.2mm ≈ 602px。图片超过就等比缩 */
const CONTENT_PX = 600;

const BULLET_REF = 'donote-bullet';

/* ---------------------------- Markdown token ---------------------------- */

/** markdown-it 的 Token 只用到这几个字段，本地声明一份省掉类型依赖 */
interface MdToken {
  type: string;
  tag: string;
  content: string;
  children: MdToken[] | null;
  attrGet?: (name: string) => string | null;
}

type Inline = TextRun | ImageRun | ExternalHyperlink;

/** 一段文字的统一基线样式（标题要粗、要大，靠它一次传给所有 run） */
interface RunBase {
  bold?: boolean;
  size?: number;
  color?: string;
}

interface BuildState {
  numbering: INumberingOptions['config'][number][];
  seq: number;
}

/* -------------------------------- 图片 -------------------------------- */

type RasterType = 'png' | 'jpg' | 'gif' | 'bmp';

interface ImageInfo {
  data: Uint8Array;
  type: RasterType;
  width: number;
  height: number;
}

const EXT_TYPE: Record<string, RasterType> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  bmp: 'bmp',
};

/** 量图片像素尺寸；量不出来按 16:9 摆，总比丢图好 */
async function measure(bytes: ArrayBuffer, type: RasterType): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${type}` }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    /* 浏览器认不出的格式（比如老 BMP）走默认尺寸 */
  }
  return { width: 480, height: 270 };
}

/** 把正文里所有图片读进内存：src → 字节 + 尺寸 */
async function collectImages(
  tokens: MdToken[],
  notePath: string,
): Promise<{ map: Map<string, ImageInfo>; missed: number }> {
  const srcs = new Set<string>();
  for (const token of tokens) {
    for (const child of token.children ?? []) {
      if (child.type !== 'image') continue;
      const src = child.attrGet?.('src') ?? '';
      if (src) srcs.add(src);
    }
  }

  const map = new Map<string, ImageInfo>();
  let missed = 0;
  for (const src of srcs) {
    const path = resolveAssetPath(notePath, src);
    if (!path) continue; // 外链不动
    const type = EXT_TYPE[(path.split('.').pop() ?? '').toLowerCase()];
    if (!type) {
      missed += 1; // SVG / WebP：Word 不收，宁可报数也不塞个坏图
      continue;
    }
    try {
      const bytes = await getStorage().readBytes(path);
      map.set(src, { data: new Uint8Array(bytes), type, ...(await measure(bytes, type)) });
    } catch {
      missed += 1;
    }
  }
  return { map, missed };
}

function imageRun(token: MdToken, images: Map<string, ImageInfo>): ImageRun | null {
  const info = images.get(token.attrGet?.('src') ?? '');
  if (!info) return null;
  // 只缩不放：小图拉大会糊
  const scale = Math.min(1, CONTENT_PX / info.width, 760 / info.height);
  const alt = token.content || '图片';
  return new ImageRun({
    type: info.type,
    data: info.data,
    transformation: {
      width: Math.round(info.width * scale),
      height: Math.round(info.height * scale),
    },
    altText: { name: alt, description: alt, title: alt },
  });
}

/* -------------------------------- 行内 -------------------------------- */

function inlineRuns(
  token: MdToken | undefined,
  images: Map<string, ImageInfo>,
  base: RunBase = {},
): Inline[] {
  const out: Inline[] = [];
  if (!token?.children) return out;

  let bold = 0;
  let italics = 0;
  let strike = 0;
  let link: string | null = null;

  const push = (text: string): void => {
    if (!text) return;
    const run = new TextRun({
      text,
      bold: base.bold || bold > 0 || undefined,
      italics: italics > 0 || undefined,
      strike: strike > 0 || undefined,
      size: base.size,
      color: base.color ?? (link ? '1155CC' : undefined),
      underline: link ? {} : undefined,
    });
    out.push(link ? new ExternalHyperlink({ link, children: [run] }) : run);
  };

  for (const child of token.children) {
    switch (child.type) {
      case 'text':
        push(child.content);
        break;
      case 'strong_open':
        bold += 1;
        break;
      case 'strong_close':
        bold = Math.max(0, bold - 1);
        break;
      case 'em_open':
        italics += 1;
        break;
      case 'em_close':
        italics = Math.max(0, italics - 1);
        break;
      case 's_open':
        strike += 1;
        break;
      case 's_close':
        strike = Math.max(0, strike - 1);
        break;
      case 'code_inline':
        out.push(new TextRun({ text: child.content, font: MONO, size: 20, shading: { fill: 'F2F2F2' } }));
        break;
      case 'link_open':
        link = child.attrGet?.('href') ?? null;
        break;
      case 'link_close':
        link = null;
        break;
      case 'softbreak':
        push(' ');
        break;
      case 'hardbreak':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'image': {
        const run = imageRun(child, images);
        if (run) out.push(run);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* -------------------------------- 块级 -------------------------------- */

/** 找到与 openIndex 处开标签配对的闭标签（同类开标签会嵌套，得计层） */
function findClose(tokens: MdToken[], openIndex: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    if (tokens[i].type === openType) depth += 1;
    else if (tokens[i].type === closeType) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

function nextOrderedRef(state: BuildState): string {
  const reference = `donote-num-${state.seq}`;
  state.seq += 1;
  // 每个有序列表一个引用 = 各自从 1 开始；共用一个会接着上一段往下数
  state.numbering.push({ reference, levels: orderedLevels() });
  return reference;
}

function orderedLevels(): ILevelsOptions[] {
  return [0, 1, 2, 3, 4].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 420 * (level + 1) + 200, hanging: 420 } } },
  }));
}

function bulletLevels(): ILevelsOptions[] {
  const marks = ['•', '◦', '▪', '•', '◦'];
  return marks.map((mark, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: mark,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 420 * (level + 1) + 200, hanging: 420 } } },
  }));
}

function codeBlock(content: string): Paragraph {
  const lines = content.replace(/\n+$/, '').split('\n');
  const runs: TextRun[] = [];
  lines.forEach((line, index) => {
    runs.push(new TextRun({ text: line, break: index === 0 ? undefined : 1, font: MONO, size: 19 }));
  });
  return new Paragraph({
    children: runs,
    shading: { fill: 'F5F5F5' },
    spacing: { before: 120, after: 160, line: 260 },
    indent: { left: 120, right: 120 },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0', space: 6 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0', space: 6 },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0', space: 6 },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'E0E0E0', space: 6 },
    },
  });
}

function buildTable(tokens: MdToken[], images: Map<string, ImageInfo>): Table {
  const rows: TableRow[] = [];
  let header = false;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'thead_open') {
      header = true;
      i += 1;
      continue;
    }
    if (token.type === 'thead_close') {
      header = false;
      i += 1;
      continue;
    }
    if (token.type === 'tr_open') {
      const end = findClose(tokens, i, 'tr_open', 'tr_close');
      const cells: TableCell[] = [];
      let j = i + 1;
      while (j < end) {
        const cell = tokens[j];
        if (cell.type === 'th_open' || cell.type === 'td_open') {
          const cellEnd = findClose(tokens, j, cell.type, cell.type.replace('_open', '_close'));
          const runs: Inline[] = [];
          for (let k = j + 1; k < cellEnd; k += 1) {
            if (tokens[k].type === 'inline') runs.push(...inlineRuns(tokens[k], images, { bold: header }));
          }
          cells.push(
            new TableCell({
              children: [new Paragraph({ children: runs.length ? runs : [new TextRun('')], spacing: { before: 40, after: 40, line: 280 } })],
              shading: header ? { fill: 'F2F2F2' } : undefined,
              margins: { top: 60, bottom: 60, left: 110, right: 110 },
            }),
          );
          j = cellEnd + 1;
          continue;
        }
        j += 1;
      }
      rows.push(new TableRow({ children: cells, tableHeader: header }));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/**
 * 列表项：第一段带编号，项内的续段与嵌套列表跟在后面。
 * 嵌套靠 level 递进（最多 5 层），缩进由编号定义里的 indent 负责。
 */
function buildItem(
  tokens: MdToken[],
  reference: string,
  level: number,
  images: Map<string, ImageInfo>,
  state: BuildState,
  depth: number,
): Paragraph[] {
  const out: Paragraph[] = [];
  let numbered = false;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!numbered && token.type === 'paragraph_open') {
      const runs = inlineRuns(tokens[i + 1], images);
      out.push(
        new Paragraph({
          children: runs.length ? runs : [new TextRun('')],
          numbering: { reference, level },
          spacing: { after: 60, line: 340 },
        }),
      );
      numbered = true;
      i += 3;
      continue;
    }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const ordered = token.type === 'ordered_list_open';
      const end = findClose(
        tokens,
        i,
        token.type,
        ordered ? 'ordered_list_close' : 'bullet_list_close',
      );
      out.push(...buildList(tokens.slice(i + 1, end), ordered, images, state, depth + 1));
      i = end + 1;
      continue;
    }
    if (token.type === 'paragraph_open') {
      const runs = inlineRuns(tokens[i + 1], images);
      if (runs.length) {
        out.push(
          new Paragraph({
            children: runs,
            indent: { left: 420 * (level + 1) + 200 },
            spacing: { after: 60, line: 340 },
          }),
        );
      }
      i += 3;
      continue;
    }
    i += 1;
  }
  if (!numbered) {
    // 「- 」后面什么都没写：编号不能丢，否则这一项在 Word 里凭空消失
    out.unshift(
      new Paragraph({ numbering: { reference, level }, children: [new TextRun('')] }),
    );
  }
  return out;
}

function buildList(
  tokens: MdToken[],
  ordered: boolean,
  images: Map<string, ImageInfo>,
  state: BuildState,
  depth: number,
): Paragraph[] {
  const level = Math.min(depth, 4);
  const reference = ordered ? nextOrderedRef(state) : BULLET_REF;
  const out: Paragraph[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type === 'list_item_open') {
      const end = findClose(tokens, i, 'list_item_open', 'list_item_close');
      out.push(...buildItem(tokens.slice(i + 1, end), reference, level, images, state, depth));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function buildBlocks(
  tokens: MdToken[],
  images: Map<string, ImageInfo>,
  state: BuildState,
  depth: number,
  quote: boolean,
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open': {
        const level = Math.min(Math.max(Number(token.tag.slice(1)) || 1, 1), 6);
        out.push(
          new Paragraph({
            heading: HEADINGS[level - 1],
            children: inlineRuns(tokens[i + 1], images),
          }),
        );
        i += 3;
        break;
      }
      case 'paragraph_open': {
        const runs = inlineRuns(tokens[i + 1], images);
        if (runs.length) {
          out.push(
            new Paragraph({
              children: runs,
              ...(quote
                ? {
                    indent: { left: 360 },
                    border: {
                      left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D0D0', space: 10 },
                    },
                  }
                : {}),
            }),
          );
        }
        i += 3;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const end = findClose(
          tokens,
          i,
          token.type,
          ordered ? 'ordered_list_close' : 'bullet_list_close',
        );
        out.push(...buildList(tokens.slice(i + 1, end), ordered, images, state, depth));
        i = end + 1;
        break;
      }
      case 'blockquote_open': {
        const end = findClose(tokens, i, 'blockquote_open', 'blockquote_close');
        out.push(...buildBlocks(tokens.slice(i + 1, end), images, state, depth, true));
        i = end + 1;
        break;
      }
      case 'fence':
      case 'code_block':
        out.push(codeBlock(token.content));
        i += 1;
        break;
      case 'table_open': {
        const end = findClose(tokens, i, 'table_open', 'table_close');
        out.push(buildTable(tokens.slice(i + 1, end), images));
        i = end + 1;
        break;
      }
      case 'hr':
        out.push(
          new Paragraph({
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 },
            },
            spacing: { before: 160, after: 220 },
          }),
        );
        i += 1;
        break;
      default:
        i += 1;
        break;
    }
  }
  return out;
}

/* -------------------------------- 组装 -------------------------------- */

const TWIP = (mm: number): number => convertMillimetersToTwip(mm);

export interface DocxResult {
  blob: Blob;
  /** 内嵌成功的图片数 */
  images: number;
  /** 读不到或 Word 不收的图片数 */
  missed: number;
}

export async function buildDocxFile(note: ExportNote): Promise<DocxResult> {
  const tokens = md.parse(note.content, {}) as unknown as MdToken[];
  const { map, missed } = await collectImages(tokens, note.path);

  const state: BuildState = { numbering: [], seq: 0 };
  const body = buildBlocks(tokens, map, state, 0, false);
  // 只要出现过无序列表就得有这份定义（有引用没定义 Word 会报「文档已损坏」）
  state.numbering.push({ reference: BULLET_REF, levels: bulletLevels() });

  const title = note.title.trim() || '无标题笔记';
  const doc = new Document({
    creator: 'DoNote',
    title,
    numbering: { config: state.numbering },
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 24, color: '000000' },
          paragraph: { spacing: { line: 360, after: 120 } },
        },
        heading1: {
          run: { font: FONT, size: 32, bold: true, color: '000000' },
          paragraph: { spacing: { before: 320, after: 160, line: 320 }, keepNext: true },
        },
        heading2: {
          run: { font: FONT, size: 28, bold: true, color: '000000' },
          paragraph: { spacing: { before: 280, after: 140, line: 320 }, keepNext: true },
        },
        heading3: {
          run: { font: FONT, size: 24, bold: true, color: '000000' },
          paragraph: { spacing: { before: 240, after: 120, line: 320 }, keepNext: true },
        },
        heading4: {
          run: { font: FONT, size: 22, bold: true, color: '000000' },
          paragraph: { spacing: { before: 200, after: 100, line: 320 }, keepNext: true },
        },
        heading5: {
          run: { font: FONT, size: 22, bold: true, color: '000000' },
          paragraph: { spacing: { before: 180, after: 100, line: 320 }, keepNext: true },
        },
        heading6: {
          run: { font: FONT, size: 21, bold: true, color: '000000' },
          paragraph: { spacing: { before: 160, after: 100, line: 320 }, keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: TWIP(210), height: TWIP(297) },
            margin: { top: TWIP(25.4), right: TWIP(25.4), bottom: TWIP(25.4), left: TWIP(25.4) },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'],
                    font: FONT,
                    size: 18,
                    color: '808080',
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 320, line: 340 },
            children: [new TextRun({ text: title, font: FONT, size: 36, bold: true })],
          }),
          ...body,
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  return { blob, images: map.size, missed };
}
