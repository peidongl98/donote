/**
 * Milkdown 实例的装配。
 *
 * 只用 commonmark + gfm + history + listener + math + mermaid 六件：
 * - commonmark / gfm 是段落、列表、表格、任务清单、删除线这些基础节点
 * - history 提供撤销重做
 * - listener 提供「内容变了 / 失焦 / 选区变了」三类事件，工具栏的状态高亮也靠它
 * - math 见 ./math.ts，mermaid 见 ./mermaid.ts
 *
 * 没有加 plugin-trailing：它会在文末补一个空段落，白白多出一次规范化，收益不抵代价。
 */

import type { Ctx } from '@milkdown/kit/ctx';
import type { Selection } from '@milkdown/kit/prose/state';
import { Editor, defaultValueCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/kit/core';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
// ProseMirror 的基础样式必须自己引：少了 white-space: pre-wrap / word-wrap，
// 空白段落与断行的盒模型和 ProseMirror 的预期不一致，「点到哪 = 光标落到哪」会算错，
// 表现就是点完空段落之后选区没跟上、下一次回车把上一段选中的文字删掉。
import '@milkdown/kit/prose/view/style/prosemirror.css';
// 表格同理：少了它，单元格选中态和列宽约束都不对
import '@milkdown/kit/prose/tables/style/tables.css';
import { math } from './math';
import { mermaid } from './mermaid';
import { wikilinks, type WikilinkHandlers } from './wikilink';

export interface EditorHooks {
  /** 初始内容。走 defaultValue 而不是建好后再 replace，打开笔记时不会有任何「写」的动作 */
  defaultValue?: string;
  /** 只读模式。返回 false 时编辑器不可编辑，但内容照常渲染 */
  editable?: () => boolean;
  /**
   * `[[笔记名]]` 链接。**不传就不装这个插件** ——
   * 只读场景（回收站）与源码模式都没有它，装上去只是白扫一遍文档。
   */
  wikilink?: WikilinkHandlers;
  onMarkdownUpdated?: (markdown: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  onSelectionUpdated?: (ctx: Ctx, selection: Selection) => void;
  /** 文档变了（打字、回车、点工具栏），用来刷新工具栏高亮 */
  onUpdated?: (ctx: Ctx) => void;
}

export function createNoteEditor(root: HTMLElement, hooks: EditorHooks = {}): Editor {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, hooks.defaultValue ?? '');

      if (hooks.editable) {
        const editable = hooks.editable;
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => editable() }));
      }

      const bus = ctx.get(listenerCtx);
      if (hooks.onMarkdownUpdated) {
        const handler = hooks.onMarkdownUpdated;
        bus.markdownUpdated((_ctx, markdown) => handler(markdown));
      }
      if (hooks.onBlur) {
        const handler = hooks.onBlur;
        bus.blur(() => handler());
      }
      if (hooks.onFocus) {
        const handler = hooks.onFocus;
        bus.focus(() => handler());
      }
      if (hooks.onSelectionUpdated) {
        const handler = hooks.onSelectionUpdated;
        bus.selectionUpdated((ctx, selection) => handler(ctx, selection));
      }
      if (hooks.onUpdated) {
        const handler = hooks.onUpdated;
        bus.updated((ctx) => handler(ctx));
      }
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(math)
    .use(mermaid);

  if (hooks.wikilink) editor.use(wikilinks(hooks.wikilink));
  return editor;
}
