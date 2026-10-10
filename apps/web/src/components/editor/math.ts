/**
 * LaTeX 支持。
 *
 * Milkdown 的 commonmark / gfm 预设里没有公式，`$$…$$` 会被当成普通段落文字，
 * 走进 CommonMark 的「反斜杠转义」规则 —— `\,` `\:` `\;` `\!` 以及矩阵换行 `\\`
 * 在解析阶段就被吃掉，序列化器最后只看到 `,` `:` `;` `!` `\`。
 *
 * 所以这里把公式注册成真正的节点：解析交给 remark-math，序列化交给 mdast-util-math,
 * 后者把 `node.value` 原样写回。
 *
 * 调研过程与逐字节实测见 docs/math-fix-poc.md。
 *
 * ⚠️ 本批次只保证「保存保真」，不渲染排版结果 —— 公式在编辑器里显示为等宽的 LaTeX 原文。
 * 要不要接 KaTeX 是独立的决定（会新增一个依赖），本批次按「不引入新依赖」的约束没有接。
 */

import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { $nodeSchema, $remark } from '@milkdown/kit/utils';
import remarkMath from 'remark-math';

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

/** `$remark` / `$nodeSchema` 返回的是 `[ctx, plugin]` 元组，得 flat 开才是插件列表 */
export const math: MilkdownPlugin[] = [remarkMathPlugin, mathInlineSchema, mathBlockSchema].flat();
