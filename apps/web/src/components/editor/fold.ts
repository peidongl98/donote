/**
 * 列表折叠（收起某一级下面的整棵子树）。
 *
 * 做法是纯装饰：给 `list_item` 挂一个 class（`is-folded`），CSS 里把它的子列表
 * `display: none` 掉；同时在段落末尾插一个按钮。**文档、序列化、`.md` 全都没动过** ——
 * 折叠是「怎么看」，不是「是什么」，所以它不落盘，重开笔记一律展开。
 *
 * 三条必须守住的边界：
 *
 * 1. **位置会漂**。折叠记的是文档位置，任何一次插入 / 删除都会让后面的位置整体挪动，
 *    所以每次事务都要用 `tr.mapping` 把位置映射过去；映射完还得再确认那个位置
 *    还是个「有子级的列表项」，否则就丢掉（节点被删掉了）。
 * 2. **光标不能落进看不见的地方**。光标一旦进入被折叠的子树，那条就自动展开 —— 否则
 *    用户按方向键会掉进 `display: none` 里，界面看起来像卡死。撤销 / 重做也要靠这条兜住。
 * 3. **不能包一层容器**。按钮是以行内 widget 的形式**插在段落的文字流里**的，不重建 li 的
 *    内部结构：`li > p` 这个形状有别的规则（任务清单的 flex、`li > p { margin: 0 }`）在依赖。
 */
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

const KEY = new PluginKey<readonly number[]>('donote-fold');

/** 折叠状态：被折叠的列表项**起始位置**的集合 */
export type FoldedState = readonly number[];

function isList(node: PMNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

/** 这个列表项下面还有没有列表（没有就没有可折叠的东西，不给按钮） */
function hasChildList(node: PMNode): boolean {
  if (node.type.name !== 'list_item') return false;
  let found = false;
  node.forEach((child) => {
    if (isList(child)) found = true;
  });
  return found;
}

/** 折叠项里「自己那段文字」与「被藏起来的子列表」的分界 */
function hiddenFrom(node: PMNode): number {
  const first = node.firstChild;
  if (!first) return node.nodeSize;
  return 1 + first.nodeSize;
}

function toggleButton(folded: boolean): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'donote-fold';
  button.contentEditable = 'false';
  button.tabIndex = -1;
  button.title = folded ? '展开这一级' : '收起这一级';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', folded ? 'false' : 'true');
  // 一个朝下的细箭头；折叠时由 CSS 转成朝右（见 styles/list-style.css）
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return button;
}

function buildDecorations(doc: PMNode, folded: readonly number[]): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!hasChildList(node)) return;
    const isFolded = folded.includes(pos);
    if (isFolded) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-folded' }));
    // 按钮挂在**第一个子节点末尾**：也就是这一条自己的文字后面，子列表之前
    const at = pos + 1 + (node.firstChild?.nodeSize ?? 0) - 1;
    const key = `fold-${pos}-${isFolded ? 'c' : 'o'}`;
    decos.push(Decoration.widget(at, () => toggleButton(isFolded), { side: 1, key }));
  });
  return DecorationSet.create(doc, decos);
}

function mapFolded(tr: Transaction, folded: readonly number[]): FoldedState {
  if (!folded.length) return folded;
  const head = tr.selection ? tr.selection.head : null;

  const next: number[] = [];
  for (const old of folded) {
    const pos = tr.mapping.map(old, -1);
    const node = tr.doc.nodeAt(pos);
    // 节点没了（被删 / 被合并）→ 这条折叠状态作废
    if (!node || !hasChildList(node)) continue;
    // 光标落进了被藏起来的那一段 → 自动展开
    if (head != null && head >= pos + hiddenFrom(node) && head <= pos + node.nodeSize) continue;
    if (!next.includes(pos)) next.push(pos);
  }
  return next;
}

/** 折叠 / 展开某个列表项。pos 是该 `list_item` 节点自身的起始位置。 */
export function toggleFold(tr: Transaction, folded: FoldedState, pos: number): Transaction {
  const next = folded.includes(pos) ? folded.filter((p) => p !== pos) : [...folded, pos];
  return tr.setMeta(KEY, next);
}

export function foldPlugin(): Plugin<readonly number[]> {
  return new Plugin<readonly number[]>({
    key: KEY,
    state: {
      init: () => [] as FoldedState,
      apply(tr, folded) {
        const meta = tr.getMeta(KEY) as FoldedState | undefined;
        if (meta) return meta;
        return mapFolded(tr, folded);
      },
    },
    props: {
      decorations(state) {
        return buildDecorations(state.doc, KEY.getState(state) ?? []);
      },
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target as HTMLElement | null;
          const button = target?.closest?.('.donote-fold');
          if (!button) return false;
          // 不抢焦点、不动选区：点完光标还在原地，用户可以接着打字
          event.preventDefault();
          const li = button.closest('li');
          if (!li) return true;
          // posAtDOM(li, 0) 是 li **内容**的起点，减 1 才是 li 节点自身
          const pos = view.posAtDOM(li, 0) - 1;
          const node = view.state.doc.nodeAt(pos);
          if (!node || !hasChildList(node)) return true;
          const folded = KEY.getState(view.state) ?? [];
          view.dispatch(toggleFold(view.state.tr, folded, pos));
          return true;
        },
      },
    },
  });
}
