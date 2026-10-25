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

/** 节点盒子的尺寸：布局和画布两边各写一份容易对不上，统一从这里取 */
export const FLOW_NODE_W = 150;
export const FLOW_NODE_H = 46;

/** 从 header 读方向：`flowchart TD` 竖着排，`LR` 横着排。读不出来按竖排 */
export function flowDirection(header: string): 'TB' | 'LR' {
  const hit = /\b(TB|TD|BT|LR|RL)\b/i.exec(header ?? '');
  const dir = (hit?.[1] ?? 'TD').toUpperCase();
  return dir === 'LR' || dir === 'RL' ? 'LR' : 'TB';
}

/**
 * 分层。**回边不参与分层** —— 这是这一版最关键的一处。
 *
 * 原来的写法是「能走多深就记多深」，遇上有回路的图（试测流程图里「题目不够 → 回到第 4 步」
 * 就是一条）会一路往下算到第 60 层才停：于是 12 个节点被推到 x≈12600 的位置，
 * 画布一万多像素宽，屏幕上只剩一条横穿整个画布的连线。
 *
 * 现在先找会成环的边（回到当前 DFS 路径上的祖先），按 DAG 算最长路径，
 * 层数最多等于节点数。回路本身还在，只是不再参与排版。
 */
function layering(doc: FlowDoc): string[][] {
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const node of doc.nodes) {
    out.set(node.id, []);
    into.set(node.id, []);
  }
  for (const edge of doc.edges) {
    out.get(edge.from)?.push(edge.to);
    into.get(edge.to)?.push(edge.from);
  }

  const post: string[] = [];
  const seen = new Set<string>();
  const path = new Set<string>();
  const back = new Set<string>();
  const visit = (id: string): void => {
    seen.add(id);
    path.add(id);
    for (const to of out.get(id) ?? []) {
      if (path.has(to)) {
        back.add(`${id}>${to}`);
        continue;
      }
      if (!seen.has(to)) visit(to);
    }
    path.delete(id);
    post.push(id);
  };
  const hasIn = new Set(doc.edges.map((edge) => edge.to));
  for (const node of doc.nodes) if (!hasIn.has(node.id) && !seen.has(node.id)) visit(node.id);
  // 整张图都是环（没有入口节点）时也得挑一个起点，否则谁都不会被访问
  for (const node of doc.nodes) if (!seen.has(node.id)) visit(node.id);

  const depth = new Map<string, number>();
  for (const id of post.reverse()) {
    let at = 0;
    for (const from of into.get(id) ?? []) {
      if (back.has(`${from}>${id}`)) continue;
      at = Math.max(at, (depth.get(from) ?? 0) + 1);
    }
    depth.set(id, at);
  }

  const layers: string[][] = [];
  for (const node of doc.nodes) {
    const at = depth.get(node.id) ?? 0;
    while (layers.length <= at) layers.push([]);
    layers[at].push(node.id);
  }

  // 相邻两层各扫两轮：把节点往它的前驱旁边挪，减少连线交叉。
  // 只求「看着顺」，不做通用的最小交叉算法 —— 那是图库的活。
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < layers.length; i += 1) {
      const prev = new Map(layers[i - 1].map((id, index) => [id, index]));
      const weight = new Map<string, number>();
      for (const id of layers[i]) {
        let sum = 0;
        let count = 0;
        for (const from of into.get(id) ?? []) {
          const at = prev.get(from);
          if (at === undefined) continue;
          sum += at;
          count += 1;
        }
        weight.set(id, count ? sum / count : Number.MAX_SAFE_INTEGER);
      }
      layers[i].sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));
    }
  }

  return layers.filter((layer) => layer.length > 0);
}

/**
 * 自动排版：没存坐标（或者存的坐标不可信）时用。
 *
 * 方向跟着 `flowchart TD/LR` 走 —— 正文里是竖着画的图，打开面板却横过来，
 * 等于让人重新认一遍结构。
 */
export function autoLayout(doc: FlowDoc, nodeW = FLOW_NODE_W, nodeH = FLOW_NODE_H): void {
  const direction = flowDirection(doc.header);
  const layers = layering(doc);
  if (!layers.length) return;

  const pad = 40;
  const gapMain = direction === 'TB' ? 46 : 88;
  const gapCross = direction === 'TB' ? 40 : 24;
  const crossSize = direction === 'TB' ? nodeW : nodeH;
  const widest = Math.max(...layers.map((layer) => layer.length), 1);
  const span = widest * (crossSize + gapCross) - gapCross;

  layers.forEach((ids, index) => {
    // 每一层都居中，不左对齐 —— 单节点的层不会全都挤在左上角
    const used = ids.length * (crossSize + gapCross) - gapCross;
    const start = pad + (span - used) / 2;
    ids.forEach((id, row) => {
      const node = doc.nodes.find((item) => item.id === id);
      if (!node) return;
      const cross = Math.round(start + row * (crossSize + gapCross));
      if (direction === 'TB') {
        node.x = cross;
        node.y = pad + index * (nodeH + gapMain);
      } else {
        node.x = pad + index * (nodeW + gapMain);
        node.y = cross;
      }
    });
  });
}

/**
 * 存回来的坐标还能不能信。
 *
 * 0.4.9 之前打开过那张「有回路」的流程图并点过「完成」的笔记，`@pos` 里已经把
 * 一万多像素的坐标写死了 —— 只修排版不修这里，那些笔记打开还是老样子。
 * 判据用「整张图的外接尺寸 vs 节点数」：人拖不出这么远。
 */
function placementsSane(nodes: FlowNode[], nodeW: number, nodeH: number): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return false;
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + nodeW);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + nodeH);
  }
  const budget = Math.max(4000, nodes.length * 700);
  return maxX - minX <= budget && maxY - minY <= budget && minX >= -budget && minY >= -budget;
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
  if (placed.size) {
    for (const [id, point] of placed) {
      const node = doc.nodes.find((item) => item.id === id);
      if (node) {
        node.x = point.x;
        node.y = point.y;
      }
    }
    // 坐标离谱（老版本在有回路的图上算出来的那一万多像素）就当没存过，重新排
    if (!placementsSane(doc.nodes, FLOW_NODE_W, FLOW_NODE_H)) autoLayout(doc);
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
