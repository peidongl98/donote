/**
 * LaTeX 公式：保存（批次 2 起）与渲染（本批新增）。
 *
 * **保存**这一层早就在，本批不动：解析交给 remark-math、序列化交给 mdast-util-math，
 * `$…$` / `$$…$$` 落盘时原样保真 —— 包括 `\,` `\:` `\;` 与矩阵换行 `\\` 这些曾被
 * CommonMark「反斜杠转义」规则吃掉的指令（调研与逐字节实测见 docs/math-fix-poc.md）。
 *
 * **渲染**这一层是新加的，交互与 Mermaid 块（./mermaid.ts）同构：NodeView 只画排版结果，
 * 点击弹面板改源码，关闭时一次事务写回。节点、属性、序列化规则一个字节没变。
 *
 * KaTeX 是**静态引入**的，没有像 Mermaid 那样动态 import —— 它 min 后约 280KB（gzip 约 90KB），
 * 而公式是行内的：第一次渲染就发生在首屏，动态加载会让正文里的公式先闪一下 LaTeX 原文。
 */

import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { Plugin } from '@milkdown/kit/prose/state';
import { $nodeSchema, $prose, $remark, $view } from '@milkdown/kit/utils';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import remarkMath from 'remark-math';
import { shallowRef } from 'vue';

/* ------------------------------ 渲染 ------------------------------ */

export interface MathRender {
  /** 排版结果，直接塞进 innerHTML */
  html?: string;
  /** 人话的失败原因；成功时为 undefined */
  error?: string;
}

/**
 * 渲染一段 LaTeX。
 *
 * KaTeX 是同步的，所以没有 Mermaid 那套「用序号丢弃过期结果」的机制。
 * `throwOnError: false` 是关键：语法错时它不抛异常，而是把出错的那一段画成红色，
 * 原文留在原地 —— 正文与预览用同一套渲染，两处表现一致，用户一眼看得出改哪。
 */
export function renderMath(latex: string, display: boolean): MathRender {
  const text = latex.trim();
  if (!text) return { error: '还没有内容' };
  try {
    return {
      html: katex.renderToString(text, {
        displayMode: display,
        // 公式里出现中文（`\text{速度}`）不该被当成错误拦下来
        strict: false,
        throwOnError: false,
      }),
    };
  } catch {
    return { error: '语法有误' };
  }
}

/* ------------------------------ 编辑面板的开关 ------------------------------ */

export interface MathEdit {
  /** 打开那一刻的 LaTeX 源码 */
  latex: string;
  /** 块级 / 行内：决定预览怎么排 */
  display: boolean;
  /** 面板点「完成」时把新源码写回块里 */
  apply: (next: string) => void;
}

/**
 * 正在编辑的那一处；null = 面板关着。
 * NodeView 是纯 TS（拿不到 Vue 组件），面板是 Vue 浮层，两者靠这一份状态接上。
 */
export const mathEdit = shallowRef<MathEdit | null>(null);

/* ------------------------------ 写回 ------------------------------ */

/**
 * 把一个块级公式的内容换成新的 LaTeX。`pos` 是块自身的起始位置。
 *
 * 面板与工具栏都走这里，所以「什么算真的变了」只有一处判据：内容一样就一个事务都不发，
 * 免得点开面板、什么都不改、关掉也留一条撤销记录。
 */
export function writeMathBlock(view: EditorView, pos: number, next: string): void {
  const current = view.state.doc.nodeAt(pos);
  if (!current || current.type.name !== 'math_block' || current.textContent === next) return;
  view.dispatch(
    view.state.tr.replaceWith(
      pos + 1,
      pos + 1 + current.content.size,
      next ? view.state.schema.text(next) : [],
    ),
  );
}

/** 行内公式是 atom（没有可编辑内容），改的是属性而不是内容 */
export function writeMathInline(view: EditorView, pos: number, next: string): void {
  const current = view.state.doc.nodeAt(pos);
  if (!current || current.type.name !== 'math_inline' || current.attrs.value === next) return;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, value: next }));
}

/* ------------------------------ NodeView ------------------------------ */

/** 公式在正文里是「一块不可直接改的内容」，两种 NodeView 共用的外壳属性 */
function asBlockScope(dom: HTMLElement, label: string, atom: string): void {
  dom.contentEditable = 'false';
  dom.setAttribute('role', 'button');
  dom.setAttribute('tabindex', '0');
  dom.setAttribute('aria-label', label);
  dom.setAttribute(atom, '');
  dom.title = label;
}

/** 点击 / 回车 / 空格外加一个可聚焦的外壳 → 开面板。返回解绑函数 */
function wireOpen(dom: HTMLElement, view: EditorView, snapshot: () => MathEdit): () => void {
  const open = (): void => {
    // 只读（回收站里的笔记）不给编辑入口
    if (!view.editable) return;
    mathEdit.value = snapshot();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  };
  dom.addEventListener('click', open);
  dom.addEventListener('keydown', onKey);
  return () => {
    dom.removeEventListener('click', open);
    dom.removeEventListener('keydown', onKey);
  };
}

function mathBlockView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('div');
  dom.className = 'donote-math-block';
  asBlockScope(dom, '公式：点击编辑', 'data-math-block');

  let latex = node.textContent;

  const paint = (): void => {
    const result = renderMath(latex, true);
    if (result.error) {
      dom.classList.add('is-empty');
      dom.textContent = '点击输入公式';
      return;
    }
    dom.classList.remove('is-empty');
    dom.innerHTML = result.html ?? '';
  };

  /** 面板里改完 → 一次事务换掉块内容。节点还是 math_block，落盘还是 `$$…$$` */
  const write = (next: string): void => {
    const pos = getPos();
    if (typeof pos === 'number') writeMathBlock(view, pos, next);
  };

  const unwire = wireOpen(dom, view, () => ({ latex, display: true, apply: write }));
  paint();

  return {
    dom,
    // 里面全是 KaTeX 画的 HTML，不是可编辑内容；变更一律不往 ProseMirror 里报
    ignoreMutation: () => true,
    // 点击 / 选择交给上面那个监听：别让 ProseMirror 把光标塞进一个不可编辑的块
    stopEvent: () => true,
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    update: (next) => {
      if (next.type !== node.type) return false;
      if (next.textContent !== latex) {
        latex = next.textContent;
        paint();
      }
      return true;
    },
    destroy: unwire,
  };
}

function mathInlineView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('span');
  dom.className = 'donote-math-inline';
  asBlockScope(dom, '行内公式：点击编辑', 'data-math-inline');

  let value = String(node.attrs.value ?? '');

  const paint = (): void => {
    const result = renderMath(value, false);
    if (result.error) {
      dom.classList.add('is-empty');
      dom.textContent = '$…$';
      return;
    }
    dom.classList.remove('is-empty');
    dom.innerHTML = result.html ?? '';
  };

  /** 行内是 atom（没有可编辑内容），所以改的是属性而不是内容 */
  const write = (next: string): void => {
    const pos = getPos();
    if (typeof pos === 'number') writeMathInline(view, pos, next);
  };

  const unwire = wireOpen(dom, view, () => ({ latex: value, display: false, apply: write }));
  paint();

  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: () => true,
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    update: (next) => {
      if (next.type !== node.type) return false;
      const incoming = String(next.attrs.value ?? '');
      if (incoming !== value) {
        value = incoming;
        paint();
      }
      return true;
    },
    destroy: unwire,
  };
}

/* ------------------------------ 输入规则 ------------------------------ */

/**
 * 敲 `$` 时的转换。两条规则合在一个 `handleTextInput` 里，判据只有一条：**光标前已有几个 `$`**。
 *
 * - 前一个字符就是 `$`（`$$`）→ 换成一个空的块级公式，点一下进面板写。
 * - 前面 `$` 的个数是**奇数** → 说明这一个正好凑成一对，转行内公式。
 *
 * 把价格文本挡在外面靠的是「紧贴」：行内公式的 `$` 必须紧贴内容，闭合的那个 `$`
 * 前面不能是空白。`$5 到 $10` 敲第二个 `$` 时前面恰是空格，正好被这条挡住；
 * 而 `$x^2$` 的闭合 `$` 紧贴 `2`，照转。
 * 单个 `$`（`成本$100`）连奇偶那关都过不去 —— 前面 0 个，是偶数。
 *
 * Milkdown / remark-math 自带的是**解析**规则（打开已有笔记时 `$…$` 会被认出来），
 * 不含输入规则，所以这一条是自写的。粘贴走的是剪贴板解析，不经过这里。
 */
const mathInput = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (text !== '$' || from !== to) return false;
          const { state } = view;
          const $from = state.doc.resolve(from);
          const parent = $from.parent;
          if (parent.type.spec.code || !parent.isTextblock) return false;

          const before = parent.textBetween(0, $from.parentOffset, null, '\ufffc');

          // 1) `$$` → 块级公式
          if (before.endsWith('$')) {
            const block = state.schema.nodes.math_block;
            if (!block) return false;
            const empty = block.createAndFill();
            if (!empty) return false;
            const tr = state.tr.delete(from - 1, from);
            tr.replaceRangeWith(from - 1, from - 1, empty);
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          // 2) 凑成一对 `$…$` → 行内公式
          const count = (before.match(/\$/g) ?? []).length;
          if (count % 2 === 0) return false;
          const latex = before.slice(before.lastIndexOf('$') + 1);
          // 空内容、跨行、首尾带空白：都不像公式
          if (!latex || latex.includes('\n') || /^\s|\s$/.test(latex)) return false;
          const inline = state.schema.nodes.math_inline;
          if (!inline) return false;
          view.dispatch(
            state.tr
              .replaceWith(from - latex.length - 1, from, inline.create({ value: latex }))
              .scrollIntoView(),
          );
          return true;
        },
      },
    }),
);

/* ------------------------------ 节点与解析 ------------------------------ */

/** 让 remark 认识 `$…$` 与 `$$…$$` */
export const remarkMathPlugin = $remark('remarkMath', () => remarkMath);

/** 行内公式。atom：内部不可编辑，整体当一个字符处理 */
export const mathInlineSchema = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  attrs: {
    value: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span[data-math-inline]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.mathInline ?? '' }),
    },
  ],
  toDOM: (node) => [
    'span',
    {
      'data-math-inline': node.attrs.value as string,
      class: 'donote-math-inline',
      title: '行内公式（原文）',
    },
    `$${node.attrs.value as string}$`,
  ],
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value as string);
    },
  },
}));

/**
 * 块级公式。跟代码块一样是 `text*`、`code: true`，内容原样存。
 * 取值用 `textContent` 而不是 `content.firstChild?.text` —— 后者只取第一个文本子节点，
 * 多行公式（aligned 之类）会被截断。
 */
export const mathBlockSchema = $nodeSchema('math_block', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  code: true,
  parseDOM: [
    {
      tag: 'div[data-math-block]',
      preserveWhitespace: 'full',
    },
  ],
  toDOM: () => ['div', { 'data-math-block': 'true', class: 'donote-math-block' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.openNode(type);
      const value = node.value as string | null;
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.textContent);
    },
  },
}));

/* ------------------------------ 装配 ------------------------------ */

/** NodeView 必须排在 schema 之后 —— `$view` 要拿 `schema.node` */
const mathInlineViewPlugin = $view(mathInlineSchema.node, () => mathInlineView);
const mathBlockViewPlugin = $view(mathBlockSchema.node, () => mathBlockView);

/** `$remark` / `$nodeSchema` / `$view` 返回的是 `[ctx, plugin]` 元组，得 flat 开才是插件列表 */
export const math: MilkdownPlugin[] = [
  remarkMathPlugin,
  mathInlineSchema,
  mathBlockSchema,
  mathInlineViewPlugin,
  mathBlockViewPlugin,
  mathInput,
].flat();
