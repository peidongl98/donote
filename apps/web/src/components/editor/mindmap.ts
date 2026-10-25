/**
 * 思维导图的「树 ↔ mermaid 文本」互转。
 *
 * 为什么还要文本：笔记里存的仍是 ```mermaid 代码块（导出、GitHub 渲染、别的编辑器打开都还认），
 * 可视化编辑器只是它的另一种编辑方式 —— 图上改完立刻序列化回同一段代码，两边永远是一份数据。
 *
 * 只处理 `mindmap` 这一种图：流程图 / 时序图交给原来的源码框，切到可视化会给一句提示。
 *
 * 保真范围：
 * - 层级、文字、节点形状（`[] () (()) ))(( )( {{}}`）会原样带回去；
 * - `::icon()` / `:::class` 这类样式指令**可视化模式保存时会丢**（图上看不见它们，留着等于骗人），
 *   所以面板上明说一句：要保留样式就用代码模式改。
 */

export type MindShape = 'plain' | 'square' | 'round' | 'circle' | 'bang' | 'cloud' | 'hex';

export interface MindNode {
  id: string;
  text: string;
  shape: MindShape;
  children: MindNode[];
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `m${seq}`;
}

export function createNode(text = '', shape: MindShape = 'plain'): MindNode {
  return { id: nextId(), text, shape, children: [] };
}

/**
 * 把一行 `id[文字]` / `id((文字))` / `文字` 拆成形状 + 文字。
 * 认不出形状就整行当文字 —— 宁可显示得朴素，也不要吞掉用户写的字。
 */
function parseLabel(raw: string): { text: string; shape: MindShape } {
  const line = raw.trim();
  // 去掉尾部的样式指令：`::icon(...)`、`:::class`
  const cleaned = line.replace(/\s*::icon\(.*\)\s*$/, '').replace(/\s*:::\S+\s*$/, '');
  const rules: Array<{ shape: MindShape; re: RegExp }> = [
    { shape: 'circle', re: /^\S*?\(\((.*)\)\)$/ },
    { shape: 'bang', re: /^\S*?\)\)(.*)\(\($/ },
    { shape: 'cloud', re: /^\S*?\)(.*)\($/ },
    { shape: 'hex', re: /^\S*?\{\{(.*)\}\}$/ },
    { shape: 'square', re: /^\S*?\[(.*)\]$/ },
    { shape: 'round', re: /^\S*?\((.*)\)$/ },
  ];
  for (const rule of rules) {
    const hit = rule.re.exec(cleaned);
    if (hit) return { text: hit[1].trim(), shape: rule.shape };
  }
  return { text: cleaned, shape: 'plain' };
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  if (!match) return 0;
  // 制表符按一个缩进位算：mermaid 只认「比上一级更深」，不认具体宽度
  return match[0].replace(/\t/g, '  ').length;
}

/**
 * 解析成树。不是 mindmap（或一行节点都没有）时返回 null，调用方据此退回代码模式。
 */
export function parseMindmap(code: string): MindNode | null {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*mindmap\s*$/.test(line));
  if (start < 0) return null;

  const stack: Array<{ indent: number; node: MindNode }> = [];
  let root: MindNode | null = null;

  for (const raw of lines.slice(start + 1)) {
    if (!raw.trim()) continue;
    // %% 是 mermaid 的注释
    if (raw.trim().startsWith('%%')) continue;
    // 顶格的 `title` / `accTitle` 之类指令不是节点
    if (/^\s*(accTitle|accDescr|title)\s*:/.test(raw)) continue;

    const indent = indentOf(raw);
    const { text, shape } = parseLabel(raw);
    if (shape === 'plain' && !text) continue;
    const node = createNode(text, shape);

    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    // 缩进没变深也不算错（用户手写常这样），挂到最近一层能当父级的地方
    parent.node.children.push(node);
    stack.push({ indent: Math.max(indent, parent.indent + 1), node });
  }

  return root;
}

/** 形状里的文字不能带会截断语法的符号，去掉即可（这一步只在序列化时做） */
function safeText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[[\](){}]/g, '').trim();
}

function serializeNode(node: MindNode, id: string): string {
  const text = safeText(node.text) || '（空）';
  switch (node.shape) {
    case 'square':
      return `${id}[${text}]`;
    case 'round':
      return `${id}(${text})`;
    case 'circle':
      return `${id}((${text}))`;
    case 'bang':
      return `${id}))${text}((`;
    case 'cloud':
      return `${id})${text}(`;
    case 'hex':
      return `${id}{{${text}}}`;
    default:
      return text;
  }
}

/** 树 → mermaid 文本。根节点用 `root` 作 id，其余用 `n*`，缩进两级空格 */
export function serializeMindmap(root: MindNode): string {
  const out: string[] = ['mindmap'];
  let counter = 0;
  const walk = (node: MindNode, depth: number): void => {
    counter += 1;
    const id = depth === 0 ? 'root' : `n${counter}`;
    out.push(`${'  '.repeat(depth + 1)}${serializeNode(node, id)}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out.join('\n');
}

/* ───────────────────────── 树操作（都是纯函数，返回新树） ───────────────────────── */

function cloneWithChildren(node: MindNode): MindNode {
  return { ...node, children: node.children.map(cloneWithChildren) };
}

export function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

export function addChild(root: MindNode, parentId: string, text = ''): { tree: MindNode; added: string } {
  const tree = cloneWithChildren(root);
  const parent = findNode(tree, parentId);
  const node = createNode(text);
  if (parent) parent.children.push(node);
  else tree.children.push(node);
  return { tree, added: node.id };
}

/** 加同级：挂在目标的父级下、紧挨着目标之后；目标是根就退化成加子级 */
export function addSibling(root: MindNode, id: string, text = ''): { tree: MindNode; added: string } {
  const tree = cloneWithChildren(root);
  const node = createNode(text);
  const insert = (current: MindNode): boolean => {
    const at = current.children.findIndex((child) => child.id === id);
    if (at >= 0) {
      current.children.splice(at + 1, 0, node);
      return true;
    }
    return current.children.some(insert);
  };
  if (!insert(tree)) tree.children.push(node);
  return { tree, added: node.id };
}

export function removeNode(root: MindNode, id: string): MindNode {
  const tree = cloneWithChildren(root);
  const strip = (current: MindNode): void => {
    const at = current.children.findIndex((child) => child.id === id);
    if (at >= 0) current.children.splice(at, 1);
    else current.children.forEach(strip);
  };
  strip(tree);
  return tree;
}

export function setText(root: MindNode, id: string, text: string): MindNode {
  const tree = cloneWithChildren(root);
  const node = findNode(tree, id);
  if (node) node.text = text;
  return tree;
}

/** 目标是不是自己的后代（拖拽时先拦一下：拖到自己子树里会把树弄成环） */
function isDescendant(root: MindNode, ancestorId: string, id: string): boolean {
  const ancestor = findNode(root, ancestorId);
  if (!ancestor) return false;
  return findNode(ancestor, id) !== null;
}

/** 拖拽换父级：把 `dragId` 挂到 `targetId` 底下（排最后）。非法拖拽原样返回 */
export function reparent(root: MindNode, dragId: string, targetId: string): MindNode {
  if (dragId === targetId || dragId === root.id) return root;
  if (isDescendant(root, dragId, targetId)) return root;
  const moved = findNode(root, dragId);
  if (!moved) return root;
  const without = removeNode(root, dragId);
  const tree = cloneWithChildren(without);
  const target = findNode(tree, targetId);
  if (!target) return root;
  target.children.push(cloneWithChildren(moved));
  return tree;
}

/** 布局用：叶子按出现顺序占行，父节点取子节点的中点 */
export interface PlacedNode {
  node: MindNode;
  depth: number;
  row: number;
}

export function layout(root: MindNode): { placed: PlacedNode[]; rows: number; depth: number } {
  const placed: PlacedNode[] = [];
  let row = 0;
  let maxDepth = 0;

  const walk = (node: MindNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    if (!node.children.length) {
      const at = row;
      row += 1;
      placed.push({ node, depth, row: at });
      return at;
    }
    const childRows = node.children.map((child) => walk(child, depth + 1));
    const at = (childRows[0] + childRows[childRows.length - 1]) / 2;
    placed.push({ node, depth, row: at });
    return at;
  };

  walk(root, 0);
  return { placed, rows: Math.max(row, 1), depth: maxDepth };
}
