/**
 * 流程图（`flowchart` / `graph`）的「图 ↔ mermaid 文本」互转。
 *
 * 和思维导图（mindmap.ts）的分工：
 * - **mindmap** 只表达从属 —— 有且只有一个根，连线全由层级算出来，节点不能自由摆放。
 * - **flowchart** 表达任意关系 —— 谁连谁由 `A --> B` 决定，节点位置由人摆。
 *   这就是「任意两个节点之间连一条线」要用的那种图。
 *
 * 存进笔记的仍然是一段 ```mermaid 代码块，可视化只是它的另一种编辑方式。为此多记了一样东西：
 * **节点坐标**。mermaid 自己不做布局（渲染时才排），所以坐标只能写进注释：
 *
 *     flowchart TD
 *       n1["开始"]
 *       0 --> n2
 *     %% @pos n1 40 60
 *
 * `%%` 是 mermaid 的注释，渲染时被忽略，打开图的时候读回来 —— 于是「摆好的样子」也落盘了，
 * 换台电脑打开位置不变。没有 `@pos` 的老文本按层级自动摆一次。
 *
 * 保真范围：节点文字、形状（`[] () {} ([]) (()) {{}}`）、连线方向与箭头、连线标签、坐标。
 * 认不出来的行（`subgraph` / `class` / `style` / `click`）**整段不解析** —— 返回 null，
 * 面板退回代码模式。宁可不能可视化，也不要在保存时把用户写的声明悄悄删掉。
 */

export type FlowShape = 'rect' | 'round' | 'diamond' | 'stadium' | 'circle' | 'hex';

export interface FlowNode {
  /** mermaid 里的节点 id（`A`、`n1`、`开始` 都合法） */
  id: string;
  text: string;
  shape: FlowShape;
  x: number;
  y: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** 连线上的文字（`-->|是|`） */
  label: string;
  /** false = `---`，只有线没有箭头 */
  arrow: boolean;
}

export interface FlowDoc {
  /** 第一行原样留着：`flowchart TD` / `graph LR` 都能接着用 */
  header: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const FLOW_TEMPLATE: FlowDoc = {
  header: 'flowchart TD',
  nodes: [
    { id: 'n1', text: '开始', shape: 'stadium', x: 40, y: 40 },
    { id: 'n2', text: '要判断的事', shape: 'diamond', x: 40, y: 144 },
    { id: 'n3', text: '做点什么', shape: 'rect', x: 40, y: 250 },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: '', arrow: true },
    { from: 'n2', to: 'n3', label: '是', arrow: true },
  ],
};

/* ───────────────────────────── 解析 ───────────────────────────── */

const OPENERS: Array<{ open: string; close: string; shape: FlowShape }> = [
  { open: '([', close: '])', shape: 'stadium' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '{{', close: '}}', shape: 'hex' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
];

/** id 允许中文、字母、数字、下划线 —— mermaid 自己也认这些 */
const ID_RE = /^[A-Za-z0-9_\u4e00-\u9fff]+/;

/** `-- 文字 -->` 这种「箭头里带字」的写法，长的先试 */
const TEXT_LINKS: Array<{ re: RegExp; arrow: boolean }> = [
  { re: /^--\s+(.+?)\s+-->/, arrow: true },
  { re: /^==\s+(.+?)\s+==>/, arrow: true },
  { re: /^-\.\s+(.+?)\s+\.->/, arrow: true },
  { re: /^--\s+(.+?)\s+---/, arrow: false },
];

/** 光秃秃的箭头 */
const PLAIN_LINKS: Array<{ text: string; arrow: boolean }> = [
  { text: '<-->', arrow: true },
  { text: '-->', arrow: true },
  { text: '-.->', arrow: true },
  { text: '==>', arrow: true },
  { text: '---', arrow: false },
];

interface RawNode {
  id: string;
  shape?: FlowShape;
  text?: string;
  end: number;
}

function readNode(line: string, at: number): RawNode | null {
  const id = ID_RE.exec(line.slice(at))?.[0];
  if (!id) return null;
  let cursor = at + id.length;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;

  for (const rule of OPENERS) {
    if (!line.startsWith(rule.open, cursor)) continue;
    const bodyAt = cursor + rule.open.length;
    const closeAt = line.indexOf(rule.close, bodyAt);
    if (closeAt < 0) continue;
    let text = line.slice(bodyAt, closeAt).trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    return { id, shape: rule.shape, text: text.replace(/<br\s*\/?>/gi, ' ').trim(), end: closeAt + rule.close.length };
  }
  return { id, end: at + id.length };
}

interface RawLink {
  arrow: boolean;
  label: string;
  end: number;
}

function readLink(line: string, at: number): RawLink | null {
  const rest = line.slice(at);
  for (const rule of TEXT_LINKS) {
    const hit = rule.re.exec(rest);
    if (hit) return { arrow: rule.arrow, label: hit[1].trim(), end: at + hit[0].length };
  }
  for (const rule of PLAIN_LINKS) {
    if (!rest.startsWith(rule.text)) continue;
    let end = at + rule.text.length;
    let label = '';
    // `-->|文字|`：竖线里的就是连线标签
    if (line[end] === '|') {
      const closeAt = line.indexOf('|', end + 1);
      if (closeAt > 0) {
        label = line.slice(end + 1, closeAt).trim();
        end = closeAt + 1;
      }
    }
    return { arrow: rule.arrow, label, end };
  }
  return null;
}

function upsertNode(doc: FlowDoc, raw: RawNode): FlowNode {
  let node = doc.nodes.find((item) => item.id === raw.id);
  if (!node) {
    node = { id: raw.id, text: raw.id, shape: 'rect', x: 0, y: 0 };
    doc.nodes.push(node);
  }
  if (raw.shape) node.shape = raw.shape;
  if (raw.text !== undefined) node.text = raw.text;
  return node;
}

/**
 * 解析一行 `A[文字] --> B{判断} -->|是| C`。
 * 认不出来返回 false —— 整段就当作「不能在图上改」，不猜。
 */
function parseStatement(line: string, doc: FlowDoc): boolean {
  const skip = (from: number): number => {
    let at = from;
    while (line[at] === ' ' || line[at] === '\t' || line[at] === ';') at += 1;
    return at;
  };

  let at = skip(0);
  const first = readNode(line, at);
  if (!first) return false;
  let prev = upsertNode(doc, first);
  at = first.end;

  for (;;) {
    at = skip(at);
    if (at >= line.length) return true;

    const link = readLink(line, at);
    if (!link) return false;
    at = skip(link.end);

    const raw = readNode(line, at);
    if (!raw) return false;
    const next = upsertNode(doc, raw);
    at = raw.end;

    if (prev.id !== next.id) {
      const existing = doc.edges.find((edge) => edge.from === prev.id && edge.to === next.id);
      if (existing) {
        existing.label = link.label || existing.label;
        existing.arrow = link.arrow;
      } else {
        doc.edges.push({ from: prev.id, to: next.id, label: link.label, arrow: link.arrow });
      }
    }
    prev = next;
  }
}

/**
 * 没有 `@pos` 的老文本：按「入口节点在第 0 层」往下排。
 * 只求看得清，不求好看 —— 用户随手摆一下就成了 `@pos`。
 */
function autoLayout(doc: FlowDoc): void {
  const layer = new Map<string, number>();
  const targets = new Set(doc.edges.map((edge) => edge.to));
  const roots = doc.nodes.filter((node) => !targets.has(node.id));

  const walk = (id: string, depth: number): void => {
    if (depth > 60) return;
    const seen = layer.get(id);
    if (seen !== undefined && seen >= depth) return;
    layer.set(id, depth);
    for (const edge of doc.edges) {
      if (edge.from === id) walk(edge.to, depth + 1);
    }
  };
  for (const node of roots.length ? roots : doc.nodes.slice(0, 1)) walk(node.id, 0);

  const rows = new Map<number, number>();
  for (const node of doc.nodes) {
    const depth = layer.get(node.id) ?? 2;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    node.x = 40 + depth * 210;
    node.y = 40 + row * 92;
  }
}

/** 解析成图。不是 flowchart（或有认不出的行）时返回 null，调用方据此退回代码模式 */
export function parseFlowchart(code: string): FlowDoc | null {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*(flowchart|graph)\b/.test(line));
  if (start < 0) return null;

  const doc: FlowDoc = { header: lines[start].trim(), nodes: [], edges: [] };
  const placed = new Map<string, { x: number; y: number }>();

  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('%%')) {
      const hit = /^%%\s*@pos\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(line);
      if (hit) placed.set(hit[1], { x: Number(hit[2]), y: Number(hit[3]) });
      continue;
    }
    if (!parseStatement(line, doc)) return null;
  }

  if (!doc.nodes.length) return null;

  autoLayout(doc);
  for (const [id, point] of placed) {
    const node = doc.nodes.find((item) => item.id === id);
    if (node) {
      node.x = point.x;
      node.y = point.y;
    }
  }
  return doc;
}

/* ───────────────────────────── 序列化 ───────────────────────────── */

const SHAPE_WRAP: Record<FlowShape, [string, string]> = {
  rect: ['[', ']'],
  round: ['(', ')'],
  diamond: ['{', '}'],
  stadium: ['([', '])'],
  circle: ['((', '))'],
  hex: ['{{', '}}'],
};

/** 形状里的文字：换行压成空格、双引号换成单引号（序列化一律加引号，括号就不会截断语法） */
function safeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

function formNode(node: FlowNode): string {
  const [open, close] = SHAPE_WRAP[node.shape];
  const text = safeText(node.text) || '（空）';
  return `${node.id}${open}"${text}"${close}`;
}

export function serializeFlowchart(doc: FlowDoc): string {
  const out: string[] = [doc.header || 'flowchart TD'];
  for (const node of doc.nodes) out.push(`  ${formNode(node)}`);
  for (const edge of doc.edges) {
    const arrow = edge.arrow ? '-->' : '---';
    const label = safeText(edge.label);
    out.push(`  ${edge.from} ${arrow}${label ? `|${label}|` : ''} ${edge.to}`);
  }
  out.push('');
  for (const node of doc.nodes) {
    out.push(`%% @pos ${node.id} ${Math.round(node.x)} ${Math.round(node.y)}`);
  }
  return out.join('\n');
}

/* ───────────────────────────── 图操作（纯函数，返回新图） ───────────────────────────── */

function clone(doc: FlowDoc): FlowDoc {
  return {
    header: doc.header,
    nodes: doc.nodes.map((node) => ({ ...node })),
    edges: doc.edges.map((edge) => ({ ...edge })),
  };
}

let seq = 0;
/** 新节点的 id：接在现有 `n*` 后面，避开用户自己写的那批 */
function nextId(doc: FlowDoc): string {
  const used = new Set(doc.nodes.map((node) => node.id));
  do {
    seq += 1;
  } while (used.has(`n${seq}`));
  return `n${seq}`;
}

export function addNode(doc: FlowDoc, x: number, y: number, text = ''): { doc: FlowDoc; added: string } {
  const next = clone(doc);
  const id = nextId(next);
  next.nodes.push({ id, text: text || '新节点', shape: 'rect', x: Math.round(x), y: Math.round(y) });
  return { doc: next, added: id };
}

export function moveNode(doc: FlowDoc, id: string, x: number, y: number): FlowDoc {
  const next = clone(doc);
  const node = next.nodes.find((item) => item.id === id);
  if (node) {
    node.x = Math.round(x);
    node.y = Math.round(y);
  }
  return next;
}

export function setNodeText(doc: FlowDoc, id: string, text: string): FlowDoc {
  const next = clone(doc);
  const node = next.nodes.find((item) => item.id === id);
  if (node) node.text = text;
  return next;
}

export function setNodeShape(doc: FlowDoc, id: string, shape: FlowShape): FlowDoc {
  const next = clone(doc);
  const node = next.nodes.find((item) => item.id === id);
  if (node) node.shape = shape;
  return next;
}

/** 删节点：连着它的边一起删 —— 留着悬空的边，序列化出来就是一对不存在的节点 */
export function removeNode(doc: FlowDoc, id: string): FlowDoc {
  const next = clone(doc);
  next.nodes = next.nodes.filter((node) => node.id !== id);
  next.edges = next.edges.filter((edge) => edge.from !== id && edge.to !== id);
  return next;
}

/** 连线。自己连自己、已经有同方向的边都不再添 */
export function addEdge(doc: FlowDoc, from: string, to: string): FlowDoc {
  if (from === to) return doc;
  if (!doc.nodes.some((node) => node.id === from) || !doc.nodes.some((node) => node.id === to)) return doc;
  if (doc.edges.some((edge) => edge.from === from && edge.to === to)) return doc;
  const next = clone(doc);
  next.edges.push({ from, to, label: '', arrow: true });
  return next;
}

export function removeEdge(doc: FlowDoc, from: string, to: string): FlowDoc {
  const next = clone(doc);
  next.edges = next.edges.filter((edge) => !(edge.from === from && edge.to === to));
  return next;
}

export function setEdgeLabel(doc: FlowDoc, from: string, to: string, label: string): FlowDoc {
  const next = clone(doc);
  const edge = next.edges.find((item) => item.from === from && item.to === to);
  if (edge) edge.label = label;
  return next;
}

export function edgeKey(edge: FlowEdge): string {
  return `${edge.from}->${edge.to}`;
}

/** 图的外接尺寸（放画布用） */
export function bounds(doc: FlowDoc, nodeW: number, nodeH: number): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const node of doc.nodes) {
    right = Math.max(right, node.x + nodeW);
    bottom = Math.max(bottom, node.y + nodeH);
  }
  return { width: right + 80, height: bottom + 80 };
}
