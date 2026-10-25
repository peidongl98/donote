/**
 * 「能变成导图的内容」与导图之间的双向转换。
 *
 * 两种东西可以当导图看：**嵌套列表**（圆点 / 序号，最多 9 级）和**标题大纲**（`# ## ###`）。
 * 这里只做纯数据换算，不碰视图：
 *
 *   文档节点 → 大纲条目（层级 + 文字）→ mermaid mindmap 文本 → 代码块
 *   代码块文本 → 树 → 嵌套列表节点
 *
 * 为什么统一走 mermaid 文本：导图在笔记里只有一种存储形态（```mermaid 代码块），
 * 转换出来的东西必须落到这个形态上，否则就有了第二种格式要同步、要导出、要备份。
 */
import { Fragment, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { MindNode } from './mindmap';

/** 一个条目：`depth` 从 1 开始（1 = 最外层 / H1） */
export interface OutlineItem {
  depth: number;
  text: string;
}

/** 合成根的名字。多根的内容（多个并列条目）需要一个容器节点 */
export const ROOT_LABEL = '中心主题';

function blockText(node: PMNode): string {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

/** 列表 → 条目（递归，`depth` 按列表嵌套层数算） */
function walkList(list: PMNode, depth: number, out: OutlineItem[]): void {
  list.forEach((item) => {
    if (item.type.name !== 'list_item') return;
    // 一条自己的文字 = 它第一个段落；子列表在后面单独走
    const head = item.firstChild;
    const text = head && head.type.name === 'paragraph' ? blockText(head) : '';
    out.push({ depth, text: text || '（空）' });
    item.forEach((child) => {
      if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') {
        walkList(child, depth + 1, out);
      }
    });
  });
}

/**
 * 抽出 [from, to) 之间的大纲条目。选不出东西（比如只是一段普通正文）时返回 null。
 *
 * 规则：按顶层块逐个看 —— 列表按嵌套层级算 depth；标题按 `level` 算 depth。
 * 两种混排也照出现顺序拼在一起（标题当父级、列表当子级是常见写法）。
 */
export function collectOutline(state: EditorState, from: number, to: number): OutlineItem[] | null {
  const doc = state.doc;
  const start = Math.max(0, from);
  const end = Math.min(doc.content.size, to);
  const out: OutlineItem[] = [];

  doc.nodesBetween(start, end, (node) => {
    if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
      walkList(node, 1, out);
      return false; // 整棵列表已经走完，别再往里钻
    }
    if (node.type.name === 'heading') {
      const level = Number(node.attrs.level ?? 1);
      out.push({ depth: Math.max(1, Math.min(6, level)), text: blockText(node) || '（空）' });
      return false;
    }
    return true;
  });

  const items = out.filter((item) => item.text.trim() !== '');
  return items.length ? items : null;
}

/** 把光标所在 / 选区覆盖的那几个顶层块的位置算出来，交给调用方整块替换 */
export function blockRange(state: EditorState): { from: number; to: number } {
  const { from, to } = state.selection;
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  const start = $from.depth > 0 ? $from.before(1) : 0;
  const end = $to.depth > 0 ? $to.after(1) : state.doc.content.size;
  return { from: start, to: end };
}

/**
 * 条目 → mermaid 文本。
 *
 * 只有一个最外层条目时拿它当根（标题大纲就是这种形状，H1 天然是根）；
 * 并列多个时补一个合成根 —— mermaid 的 mindmap 必须有且只有一个根。
 */
export function outlineToMermaid(items: OutlineItem[]): string {
  const minDepth = Math.min(...items.map((item) => item.depth));
  const tops = items.filter((item) => item.depth === minDepth);
  const useFirstAsRoot = tops.length === 1 && items.length > 1;

  const lines = ['mindmap'];
  let index = 0;

  if (!useFirstAsRoot) {
    lines.push(`  ${ROOT_LABEL}`);
    for (const item of items) {
      lines.push(`${'  '.repeat(item.depth - minDepth + 2)}${item.text}`);
    }
    return lines.join('\n');
  }

  for (const item of items) {
    index += 1;
    const depth = item.depth - minDepth; // 根为 0
    lines.push(`${'  '.repeat(depth + 1)}${item.text}`);
  }
  return lines.join('\n');
}

/** 建一个 ```mermaid 代码块节点 */
export function mermaidBlockNode(schema: Schema, text: string): PMNode | null {
  const type = schema.nodes.code_block;
  if (!type) return null;
  return type.create({ language: 'mermaid' }, schema.text(text));
}

/**
 * 导图树 → 嵌套列表节点。
 *
 * 合成根（文字是「中心主题」的那种）不落成条目 —— 它是转换时为了满足「只能有一个根」
 * 硬加出来的壳，回到列表里不该多一层。真的根（H1 转过来的）照常落成第一条。
 */
export function mermaidToBulletList(schema: Schema, tree: MindNode): PMNode | null {
  const listType = schema.nodes.bullet_list;
  const itemType = schema.nodes.list_item;
  const paraType = schema.nodes.paragraph;
  if (!listType || !itemType || !paraType) return null;

  const build = (node: MindNode): PMNode => {
    const parts: PMNode[] = [paraType.create(null, node.text ? schema.text(node.text) : null)];
    if (node.children.length) parts.push(listType.create(null, node.children.map(build)));
    return itemType.create(null, parts);
  };

  const synthetic = tree.text.trim() === ROOT_LABEL;
  const items = synthetic ? tree.children.map(build) : [build(tree)];
  if (!items.length) return null;
  return listType.create(null, items);
}

/** 空片段，替换时用得上 */
export const EMPTY = Fragment.empty;
