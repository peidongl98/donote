/**
 * `[[笔记名]]` 链接。
 *
 * ## 为什么是「纯文本 + decoration」而不是一个自定义节点
 *
 * 首要红线是**不写坏用户数据**，而任务要求「落盘存原文」。两条路：
 *
 * | 方案 | 落盘存原文这件事 |
 * |---|---|
 * | 自定义 mdast 节点（仿 math.ts） | 变成一个**必须被保证的不变量** —— 序列化器一旦不完美就把正文写坏，而 stage2 回归里有「源码模式字节精确」「落盘是 Markdown」的硬断言 |
 * | **纯文本 + ProseMirror decoration**（本文件） | 是**天然结果** —— 文本从头到尾没被改写，`[[名字]]` 就躺在正文里 |
 *
 * 代价：`[[…]]` 不能整体删除、可以往中间插字。按「先跑通」接受。
 *
 * ## 位置怎么来
 *
 * 每次文档变化时扫一遍所有 text 节点，用正则找出 `[[…]]` 的**文档位置**（不是屏幕位置），
 * 存进插件 state；decorations 再按这些位置染色。点链接时用 `handleClickOn` 拿到的 pos
 * 在这些区间里查一次就知道点的是哪一个。
 */

import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

export interface WikilinkHandlers {
  /**
   * 名字 → 笔记 id；返回 null 表示目标还不存在（渲染成红色，点一下可以创建）。
   *
   * 🔴 必须是**同步**的：decorations 是同步回调，而 `titleIndex` 是异步拉来的 ——
   * 所以索引要提前取好放在一个对象里，这里只做一次查表。
   */
  resolve: (name: string) => string | null;
  /** 点开链接。`exists` 由 resolve 的同一个答案给出，避免调用方再查一遍 */
  open: (name: string, exists: boolean) => void;
}

export interface WikilinkSpan {
  from: number;
  to: number;
  name: string;
}

const KEY = new PluginKey<WikilinkSpan[]>('donote-wikilink');
/**
 * 开头的方括号容忍反斜杠：Markdown 序列化器会把 `[[` 转义成 `\[\[`（怕 `[` 被当成链接起头），
 * 解析回来是 `[[`，但源码模式里改出来的那一份可能还带着转义。两种都认。
 */
const PATTERN = /(?:\\?\[){2}([^[\]\n]+)(?:\\?\]){2}/g;

/** 扫全文找出所有 `[[…]]` 的文档位置 */
function scan(doc: ProseNode): WikilinkSpan[] {
  const out: WikilinkSpan[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const hit of node.text.matchAll(PATTERN)) {
      const from = pos + (hit.index ?? 0);
      const name = hit[1].trim();
      if (name) out.push({ from, to: from + hit[0].length, name });
    }
  });
  return out;
}

export function wikilinks(handlers: WikilinkHandlers) {
  return $prose(
    () =>
      new Plugin<WikilinkSpan[]>({
        key: KEY,
        state: {
          init: (_config, state) => scan(state.doc),
          apply: (tr, value) => (tr.docChanged ? scan(tr.doc) : value),
        },
        props: {
          decorations(state) {
            const spans = KEY.getState(state) ?? [];
            if (!spans.length) return null;
            return DecorationSet.create(
              state.doc,
              spans.map((span) =>
                Decoration.inline(span.from, span.to, {
                  class: handlers.resolve(span.name)
                    ? 'donote-wikilink'
                    : 'donote-wikilink is-missing',
                }),
              ),
            );
          },
          handleClickOn(view, pos, _node, _nodePos, event) {
            const spans = KEY.getState(view.state) ?? [];
            const hit = spans.find((span) => pos >= span.from && pos <= span.to);
            if (!hit) return false;
            event.preventDefault();
            handlers.open(hit.name, handlers.resolve(hit.name) !== null);
            return true;
          },
        },
      }),
  );
}

/**
 * 让已渲染的 `[[…]]` 重新算一次颜色。
 *
 * decorations 平时只在**文档变化**时重算；而「目标存在与否」取决于 titleIndex，
 * 它可能在文档没变的情况下更新（比如刚点出一个新笔记、或后台补齐了索引）。
 * 空事务不会改内容、不进历史（`docChanged` 为 false），但会让 ProseMirror 重跑一遍 decorations。
 */
export function refreshWikilinks(editor: Editor | null): void {
  if (!editor) return;
  void editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view?.state) return;
    view.dispatch(view.state.tr);
  });
}
