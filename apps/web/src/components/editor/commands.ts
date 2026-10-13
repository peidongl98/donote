/**
 * 工具栏背后的一组动作。
 *
 * 能用 Milkdown 预设里现成命令的（加粗、标题、列表、表格增删…）一律调命令，
 * 不再手写一遍 ProseMirror 事务 —— 预设里已经处理了 storedMarks、输入规则、
 * 选区回退这些边界，重写只会引入新的分歧。
 *
 * 只有三件事预设里没有，才自己写：
 * 1. 任务清单：gfm 把 list_item 扩了个 checked 属性，但没有「切换」命令
 * 2. 思维导图：插入一个 language=mermaid 的代码块
 * 3. 删除当前行 / 列：gfm 只给了「删掉选中的单元格」
 */
import type { Editor } from '@milkdown/kit/core';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { callCommand } from '@milkdown/kit/utils';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorState } from '@milkdown/kit/prose/state';
import { Selection } from '@milkdown/kit/prose/state';
import { redoDepth, undoDepth } from '@milkdown/kit/prose/history';
import { redoCommand, undoCommand } from '@milkdown/kit/plugin/history';
import {
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark';
import {
  addColAfterCommand,
  addRowAfterCommand,
  createTable,
  selectColCommand,
  selectRowCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm';
import { TableMap, deleteColumn, deleteRow, deleteTable, isInTable, selectedRect } from '@milkdown/kit/prose/tables';
import { lift, wrapIn } from '@milkdown/kit/prose/commands';
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list';

/** 当前光标处的样式快照，工具栏据此高亮 */
export interface ToolbarSnapshot {
  /** 0 = 正文，1–6 = 对应级标题 */
  heading: number;
  strong: boolean;
  emphasis: boolean;
  inlineCode: boolean;
  strikethrough: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  mermaid: boolean;
  link: string | null;
  inTable: boolean;
  /** 还有没有可撤销 / 可重做的历史（顶栏那对按钮据此禁用） */
  canUndo: boolean;
  canRedo: boolean;
}

export const EMPTY_SNAPSHOT: ToolbarSnapshot = {
  heading: 0,
  strong: false,
  emphasis: false,
  inlineCode: false,
  strikethrough: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  codeBlock: false,
  mermaid: false,
  link: null,
  inTable: false,
  canUndo: false,
  canRedo: false,
};

export function snapshotOf(view: EditorView): ToolbarSnapshot {
  const { state } = view;
  const { $from, from, to } = state.selection;

  let heading = 0;
  let bulletList = false;
  let orderedList = false;
  let taskList = false;
  let blockquote = false;
  let codeBlock = false;
  let mermaid = false;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    switch (node.type.name) {
      case 'heading':
        heading = Number(node.attrs.level) || 0;
        break;
      case 'bullet_list':
        bulletList = true;
        break;
      case 'ordered_list':
        orderedList = true;
        break;
      case 'list_item':
        if (node.attrs.checked != null) taskList = true;
        break;
      case 'blockquote':
        blockquote = true;
        break;
      case 'code_block':
        codeBlock = true;
        mermaid = node.attrs.language === 'mermaid';
        break;
      default:
        break;
    }
  }

  const { marks } = state.schema;
  /** 空选区看光标处标记；有选区时要求整段都带这个标记，否则不算「命中」 */
  const hasMark = (name: string): boolean => {
    const type = marks[name];
    if (!type) return false;
    if (from === to) return (state.storedMarks ?? $from.marks()).some((m) => m.type === type);
    return state.doc.rangeHasMark(from, to, type);
  };

  let link: string | null = null;
  if (marks.link) {
    const anchor =
      from === to
        ? $from.marks().find((m) => m.type === marks.link)
        : state.doc.rangeHasMark(from, to, marks.link)
          ? state.doc.resolve(from).marks().find((m) => m.type === marks.link)
          : undefined;
    if (anchor) link = String(anchor.attrs.href ?? '');
  }

  return {
    heading,
    strong: hasMark('strong'),
    emphasis: hasMark('emphasis'),
    inlineCode: hasMark('inlineCode'),
    strikethrough: hasMark('strike_through'),
    bulletList,
    orderedList,
    taskList,
    blockquote,
    codeBlock,
    mermaid,
    link,
    inTable: isInTable(state),
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

/* ============================ 预设命令 ============================ */

type CommandKey = Parameters<typeof callCommand>[0];

function run(editor: Editor | null, key: CommandKey, payload?: unknown): void {
  if (!editor) return;
  void editor.action(callCommand(key, payload));
}

export const setHeading = (e: Editor | null, level: number): void => {
  if (level === 0) run(e, turnIntoTextCommand.key);
  else run(e, wrapInHeadingCommand.key, level);
};

export const toggleStrong = (e: Editor | null): void => run(e, toggleStrongCommand.key);
export const toggleEmphasis = (e: Editor | null): void => run(e, toggleEmphasisCommand.key);
export const toggleStrike = (e: Editor | null): void => run(e, toggleStrikethroughCommand.key);
export const toggleInlineCode = (e: Editor | null): void => run(e, toggleInlineCodeCommand.key);

/** 撤销 / 重做。能不能按由快照里的 canUndo / canRedo 决定（那对按钮据此禁用） */
export const undo = (e: Editor | null): void => run(e, undoCommand.key);
export const redo = (e: Editor | null): void => run(e, redoCommand.key);

/**
 * 插入分割线，不留多余空段落。
 *
 * 预设的 `insertHrCommand` 是 `replaceSelectionWith(hr).insert(from, paragraph)` ——
 * 它在分割线**前面**塞一个空段落，空段落序列化成 `<br />`，于是每点一次 .md 里就多一行
 * （实测见 docs/editor-audit.md P2-7）。这里改为：
 *   1. 只把分割线插进选区（与预设一致，句尾 / 段中 / 空文档都走 ProseMirror 自己的拆分）；
 *   2. 在同一个事务里找到刚插进去的那条分割线；
 *   3. **只有当它已经是文末最后一个节点时**，才在它后面补一个空段落给光标落脚 ——
 *      落在文末的空段落序列化时本来就不写成 `<br />`（证据：空文档点分割线落盘只有 `***`，
 *      末尾回车一次落盘只有那一段）。后面本来就有段落时什么都不补，光标直接落到那一段。
 *
 * 空段落既没有被删、也没有动 `preserveEmptyLine`，其余空段落逻辑一个字节没改。
 */
export const insertHr = (e: Editor | null): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const hr = state.schema.nodes.hr;
    const paragraph = state.schema.nodes.paragraph;
    if (!hr || !paragraph) return;

    const { from } = state.selection;
    const tr = state.tr.replaceSelectionWith(hr.create());

    // 同一次事务只插了一条分割线，取离原光标最近的那条（父节点的拆分会让位置前后挪）
    let at = -1;
    tr.doc.descendants((node, pos) => {
      if (node.type !== hr) return;
      if (at < 0 || Math.abs(pos - from) < Math.abs(at - from)) at = pos;
    });
    if (at < 0) return;

    const filler = at + 1 >= tr.doc.content.size;
    if (filler) tr.insert(at + 1, paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(at + (filler ? 2 : 1)), 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
};

/** 当前选区是否落在名为 name 的祖先块里（不看自己那一层之下的兄弟） */
function insideOf(view: EditorView, name: string): boolean {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) return true;
  }
  return false;
}

/**
 * 从 pos 处的节点往里钻，返回第一个「能落光标」的文本位置（pos 处的节点不是块级节点就返回 null）。
 *
 * 表格是 table → row → cell → paragraph 这样的嵌套，光标要落进最里层那段；
 * `Selection.findFrom` 不看这一层，所以才要自己走。
 */
function firstTextPosIn(doc: Node, pos: number): number | null {
  let at = pos;
  for (let depth = 0; depth < 8; depth += 1) {
    const node = doc.resolve(at).nodeAfter;
    if (!node) return null;
    if (node.isTextblock) return at + 1;
    at += 1;
  }
  return null;
}

/**
 * 引用开关。
 *
 * 预设的 `wrapInBlockquoteCommand` 就是 ProseMirror 的 `wrapIn` —— **只包不切**：
 * 连点 3 次会一路嵌套成 `> > >`，而且没有任何退路（实测见 docs/editor-audit.md P0-2）。
 * 这里补上另一半：已经在引用里就 `lift` 出来，不在才包。`lift` 会把只剩空壳的引用块一并收走。
 */
export const toggleBlockquote = (e: Editor | null): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const blockquote = view.state.schema.nodes.blockquote;
    if (!blockquote) return;
    const command = insideOf(view, 'blockquote') ? lift : wrapIn(blockquote);
    command(view.state, view.dispatch, view);
    view.focus();
  });
};

/**
 * 列表开关（无序 / 有序共用一个）。
 *
 * 预设的 `wrapInBulletList` / `wrapInOrderedList` 同样是 `wrapIn`：已经在列表里时
 * `findWrappingOutside` 返回 null、命令直接失败，**第 2 次点击毫无反应**，用户以为
 * 按钮坏了也没有取消路径（实测见 docs/editor-audit.md P1-4）。
 * 这里补上另一半：已经在列表里就 `liftListItem` 把这一条提出来（只剩一条时列表一并消失）。
 *
 * 判据是「在任意列表里」而不是「在这一种列表里」，这样任何一次点击都不会再往里套一层。
 */
function toggleList(e: Editor | null, name: 'bullet_list' | 'ordered_list'): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const list = view.state.schema.nodes[name];
    const item = view.state.schema.nodes.list_item;
    if (!list || !item) return;
    const inList = insideOf(view, 'bullet_list') || insideOf(view, 'ordered_list');
    const command = inList ? liftListItem(item) : wrapIn(list);
    command(view.state, view.dispatch, view);
    view.focus();
  });
}

export const toggleBulletList = (e: Editor | null): void => toggleList(e, 'bullet_list');
export const toggleOrderedList = (e: Editor | null): void => toggleList(e, 'ordered_list');

/** 代码块开关。预设里只有「转成代码块」，转回来要自己判断当前在不在里面 */
export const toggleCodeBlock = (e: Editor | null, inCodeBlock: boolean): void => {
  if (inCodeBlock) run(e, turnIntoTextCommand.key);
  else run(e, createCodeBlockCommand.key);
};

/**
 * 插入表格，并把光标放进**第一个单元格**。
 *
 * 预设的 `insertTableCommand` 用 `Selection.findFrom(resolve(from), 1, true)` 找落点；
 * 前面还有段落时那个位置本身就是合法的文本位置，于是光标被留在前一段里，
 * `state.inTable` 为 false → 工具栏的表格操作整行不渲染 → 用户以为「增删行列不能用」
 * （见 docs/editor-audit.md P0-3）。命令本身没错，是落点不对，所以这里自己放光标。
 *
 * 表格节点用预设的 `createTable` 造（它需要 ctx），行列结构、对齐属性都跟预设一致。
 */
export const insertTable = (e: Editor | null, row = 3, col = 3): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from } = state.selection;
    const tr = state.tr.replaceSelectionWith(createTable(ctx, row, col));
    const pos = firstTextPosIn(tr.doc, from);
    if (pos !== null) tr.setSelection(Selection.near(tr.doc.resolve(pos), 1));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
};
export const addRowAfter = (e: Editor | null): void => run(e, addRowAfterCommand.key);
export const addColAfter = (e: Editor | null): void => run(e, addColAfterCommand.key);
export const strike = (e: Editor | null): void => run(e, toggleStrikethroughCommand.key);

/* ============================ 自写命令 ============================ */

/** 把选区或光标处的所有文本节点换成普通文本，用于「清除格式」 */
export const clearFormat = (e: Editor | null): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const { from, to, empty } = state.selection;
    if (empty) {
      // 空选区：清掉「接下来要输入的字符」的待定标记
      view.dispatch(state.tr.setStoredMarks([]));
      return;
    }
    view.dispatch(state.tr.removeMark(from, to));
  });
};

/**
 * 任务清单开关。
 *
 * gfm 里任务项就是 list_item 的 checked 属性（null = 普通项）。三种情形：
 * 已在任务项里 → 整条 `liftListItem` 提出列表（回正文）；在普通列表项里 → 改成任务项；
 * 不在列表里 → 先包成无序列表再改。
 *
 * 🔴 「已在任务项里」不能只把 checked 清成 null —— 那样条目还留在列表里，
 * 用户看到的是「点第二次没回到正文」，等于没有取消路径（实测见 docs/editor-audit.md P1-6）。
 */
export function toggleTaskList(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const listItem = view.state.schema.nodes.list_item;
    const bulletList = view.state.schema.nodes.bullet_list;
    if (!listItem || !bulletList) return;

    const findItem = (): { pos: number; checked: unknown } | null => {
      const { $from } = view.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type === listItem) return { pos: $from.before(depth), checked: node.attrs.checked };
      }
      return null;
    };

    const current = findItem();
    if (current && current.checked != null) {
      liftListItem(listItem)(view.state, view.dispatch, view);
      view.focus();
      return;
    }

    let item = current;
    if (!item) {
      if (!wrapInList(bulletList)(view.state, view.dispatch)) return;
      item = findItem();
      if (!item) return;
    }

    const node = view.state.doc.nodeAt(item.pos);
    if (!node) return;
    view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...node.attrs, checked: false }));
    view.focus();
  });
}

/** 思维导图的初始骨架：先给一份能直接看到效果的模板，再让用户改 */
export const MERMAID_TEMPLATE = `mindmap
  root((中心主题))
    分支一
      子项
    分支二
    分支三`;

/** 在当前光标处插入一个 language=mermaid 的围栏代码块 */
export function insertMermaid(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const codeBlock = state.schema.nodes.code_block;
    if (!codeBlock) return;
    const node = codeBlock.create({ language: 'mermaid' }, state.schema.text(MERMAID_TEMPLATE));
    view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
  });
}

/** 删除选中的整行 / 整列。gfm 只给了「删掉选中单元格」，整行整列得自己来。 */
export function removeRow(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (isInTable(view.state)) deleteRow(view.state, view.dispatch);
  });
}

export function removeCol(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (isInTable(view.state)) deleteColumn(view.state, view.dispatch);
  });
}

export function dropTable(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (isInTable(view.state)) deleteTable(view.state, view.dispatch);
  });
}

/** 光标所在单元格的表格位置：表格节点、表内容起点、第几行第几列 */
function cellAt(state: EditorState): { table: Node; tableStart: number; col: number; row: number } | null {
  if (!isInTable(state)) return null;
  // 用 prosemirror-tables 自己的换算（selectionCell + findCell），单元格选区也认。
  // 别自己拿 $from.pos 减去内容起点去查 findCell —— 那要求「单元格节点的起点」，
  // 传任意正文位置会直接抛 RangeError: No cell with offset N found。
  const rect = selectedRect(state);
  return { table: rect.table, tableStart: rect.tableStart, col: rect.left, row: rect.top };
}

export type ColumnAlign = 'left' | 'center' | 'right';

/**
 * 把光标所在的那一列整体设为对齐。
 *
 * 🔴 不能只设当前单元格：.md 里的对齐记号（`:---:`）取自**表头行**的 alignment ——
 * `@milkdown/preset-gfm` 的 `table.toMarkdown` 只读第一行单元格。只改正文单元格会
 * 「看着变了、存下来没变」。整列一起设，既跟 Notion 一致，也保证落盘正确。
 */
export function alignColumn(e: Editor | null, alignment: ColumnAlign): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const at = cellAt(state);
    if (!at) return;

    const map = TableMap.get(at.table);
    const tr = state.tr;
    for (let row = 0; row < map.height; row += 1) {
      const pos = at.tableStart + map.positionAt(row, at.col, at.table);
      const cell = tr.doc.nodeAt(pos);
      if (!cell) continue;
      tr.setNodeMarkup(pos, undefined, { ...cell.attrs, alignment });
    }
    view.dispatch(tr);
    view.focus();
  });
}

/** 选中光标所在的整行 / 整列（选中后「对齐」会作用于整行，也方便整行删除） */
export const selectRowAt = (e: Editor | null): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!isInTable(view.state)) return;
    const at = cellAt(view.state);
    if (!at) return;
    ctx.get(commandsCtx).call(selectRowCommand.key, { index: at.row });
    view.focus();
  });
};

export const selectColAt = (e: Editor | null): void => {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!isInTable(view.state)) return;
    const at = cellAt(view.state);
    if (!at) return;
    ctx.get(commandsCtx).call(selectColCommand.key, { index: at.col });
    view.focus();
  });
};

/** 插入链接：先给选区套上链接标记；没有选区就先插入链接文字再选中它 */
export function applyLink(e: Editor | null, href: string): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const link = state.schema.marks.link;
    if (!link) return;
    const { from, to, empty } = state.selection;
    const text = empty ? href : state.doc.textBetween(from, to);
    const mark = link.create({ href });
    const tr = empty
      ? state.tr.replaceSelectionWith(state.schema.text(text, [mark]))
      : state.tr.removeMark(from, to, link).addMark(from, to, mark);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
}

export function removeLink(e: Editor | null): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const link = state.schema.marks.link;
    if (!link) return;
    const { from, to, empty } = state.selection;
    if (empty) return;
    view.dispatch(state.tr.removeMark(from, to, link));
    view.focus();
  });
}

/**
 * 在光标处插入一张图片（阶段 5 上传完成后调用）。
 *
 * 返回 Promise：派发文档变更是一次异步 action，调用方要等它落地才能读到新正文
 * （插图之后紧接着上报 / 保存，见 NoteEditor.placeImage）。
 */
export async function insertImage(e: Editor | null, src: string, alt: string): Promise<void> {
  if (!e || !src) return;
  await e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const image = state.schema.nodes.image;
    if (!image) return;
    const node = image.create({ src, alt });
    view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
  });
}

/* ============================ 块级操作（左侧 ⋮⋮ 手柄用） ============================ */

/**
 * 顶层的块。`start` 一定是 `doc` 直接子节点的起点（手柄用 `$pos.before(1)` 算出来的），
 * 所以这里直接 `nodeAt` 就能拿到那一段。
 */
function blockAt(state: EditorState, start: number): Node | null {
  const node = state.doc.nodeAt(start);
  return node ?? null;
}

/** 删除整块。只剩一块时换成空段落 —— doc 的内容约束是 block+，不能真的删空 */
export function deleteBlockAt(e: Editor | null, start: number): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const node = blockAt(state, start);
    if (!node) return;
    const tr = state.tr;
    if (state.doc.childCount === 1) {
      const paragraph = state.schema.nodes.paragraph;
      if (!paragraph) return;
      tr.replaceWith(start, start + node.nodeSize, paragraph.create());
    } else {
      tr.delete(start, start + node.nodeSize);
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
}

/** 在整块之后插入一份副本 */
export function duplicateBlockAt(e: Editor | null, start: number): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const node = blockAt(state, start);
    if (!node) return;
    const copy = node.type.create(node.attrs, node.content, node.marks);
    view.dispatch(state.tr.insert(start + node.nodeSize, copy).scrollIntoView());
    view.focus();
  });
}

/** 「转为」的目标类型 */
export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'blockquote'
  | 'codeBlock'
  | 'bullet'
  | 'ordered';

/**
 * 把整块转成另一种块。
 *
 * 文本块（段落 / 标题）保留行内内容与标记；其余（引用 / 列表 / 表格 / 分割线）拍平成纯文本
 * —— 「转为」是结构转换，不是格式转换，拍平之后落盘一定是对应的标准写法。
 */
export function convertBlockAt(e: Editor | null, start: number, kind: BlockKind): void {
  if (!e) return;
  void e.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    const nodes = state.schema.nodes;
    const node = blockAt(state, start);
    if (!node || !nodes.paragraph) return;

    const text = node.textBetween(0, node.content.size, '\n', '\n');
    const inline = node.isTextblock ? node.content : text ? state.schema.text(text) : null;
    const para = () => nodes.paragraph!.create(null, inline);

    let next: Node;
    switch (kind) {
      case 'h1':
      case 'h2':
      case 'h3':
        if (!nodes.heading) return;
        next = nodes.heading.create({ level: Number(kind.slice(1)) }, inline);
        break;
      case 'blockquote':
        if (!nodes.blockquote) return;
        next = nodes.blockquote.create(null, para());
        break;
      case 'codeBlock':
        if (!nodes.code_block) return;
        next = nodes.code_block.create(null, text ? state.schema.text(text) : null);
        break;
      case 'bullet':
      case 'ordered': {
        const list = kind === 'bullet' ? nodes.bullet_list : nodes.ordered_list;
        if (!list || !nodes.list_item) return;
        next = list.create(null, nodes.list_item.create(null, para()));
        break;
      }
      default:
        next = para();
    }

    view.dispatch(state.tr.replaceWith(start, start + node.nodeSize, next).scrollIntoView());
    view.focus();
  });
}
