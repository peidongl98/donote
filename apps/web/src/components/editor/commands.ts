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
import { editorViewCtx } from '@milkdown/kit/core';
import { callCommand } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark';
import {
  addColAfterCommand,
  addRowAfterCommand,
  insertTableCommand,
  toggleStrikethroughCommand,
} from '@milkdown/kit/preset/gfm';
import { deleteColumn, deleteRow, deleteTable, isInTable } from '@milkdown/kit/prose/tables';
import { wrapInList } from '@milkdown/kit/prose/schema-list';

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
export const toggleBulletList = (e: Editor | null): void => run(e, wrapInBulletListCommand.key);
export const toggleOrderedList = (e: Editor | null): void => run(e, wrapInOrderedListCommand.key);
export const toggleBlockquote = (e: Editor | null): void => run(e, wrapInBlockquoteCommand.key);
export const insertHr = (e: Editor | null): void => run(e, insertHrCommand.key);

/** 代码块开关。预设里只有「转成代码块」，转回来要自己判断当前在不在里面 */
export const toggleCodeBlock = (e: Editor | null, inCodeBlock: boolean): void => {
  if (inCodeBlock) run(e, turnIntoTextCommand.key);
  else run(e, createCodeBlockCommand.key);
};
export const insertTable = (e: Editor | null, row = 3, col = 3): void =>
  run(e, insertTableCommand.key, { row, col });
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
 * gfm 里任务项就是 list_item 的 checked 属性（null = 普通项）。
 * 因此三种情形：已在任务项里 → 取消；在普通列表项里 → 改成任务项；
 * 不在列表里 → 先包成无序列表再改。
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

    let item = findItem();
    if (!item) {
      if (!wrapInList(bulletList)(view.state, view.dispatch)) return;
      item = findItem();
      if (!item) return;
    }

    const node = view.state.doc.nodeAt(item.pos);
    if (!node) return;
    const next = item.checked == null ? false : null;
    view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...node.attrs, checked: next }));
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
