/**
 * Mermaid（思维导图）块的交互。
 *
 * 文档里存的仍是**普通围栏代码块**（```mermaid）：导出的 Markdown 干净，
 * GitHub / 语雀也能直接渲染 —— 数据结构一个字节没改。
 *
 * 但编辑器里**只显示渲染出来的图**（NodeView 接管 code_block，见下），源码在点击弹出的
 * 面板里改（MermaidPanel.vue）。图是块自己的 DOM，所以块手柄 / 拖动排序 / 删除都照常工作
 * —— 老做法（Decoration.widget 贴在代码块下面）做不到这一点：源码还在，图只是一层装饰。
 *
 * Mermaid 本体约 2MB，只有真的出现 mermaid 代码块时才动态 import。
 */
import type { Node } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { shallowRef } from 'vue';
import { parseMindmap } from './mindmap';
import { mermaidToBulletList } from './outline';

const MERMAID_LANG = 'mermaid';

type MermaidApi = (typeof import('mermaid'))['default'];

let loading: Promise<MermaidApi | null> | null = null;

function themeOf(): 'dark' | 'neutral' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'neutral';
}

async function loadMermaid(): Promise<MermaidApi | null> {
  if (!loading) {
    loading = import('mermaid')
      .then((mod) => {
        const api = mod.default;
        api.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: themeOf(),
          fontFamily: 'inherit',
        });
        return api;
      })
      .catch(() => null);
  }
  return loading;
}

/** 渲染结果按「主题 + 源码」缓存：光标在别处动、面板里敲字，都不必重画没变的那张 */
const cache = new Map<string, string>();

let seq = 0;

export interface MermaidRender {
  svg?: string;
  /** 人话的失败原因；成功时为 undefined */
  error?: string;
}

/** 渲染一段 mermaid 源码。语法错不抛异常，返回一句能看懂的话。 */
export async function renderMermaid(code: string): Promise<MermaidRender> {
  const text = code.trim();
  if (!text) return { error: '还没有内容' };

  const cacheKey = `${themeOf()}\u0000${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return { svg: hit };

  const api = await loadMermaid();
  if (!api) return { error: '未能加载思维导图渲染器' };
  try {
    seq += 1;
    const { svg } = await api.render(`donote-mermaid-${seq}`, text);
    cache.set(cacheKey, svg);
    return { svg };
  } catch {
    return { error: '语法有误，点开面板改一下' };
  }
}

/* ------------------------------ 编辑面板的开关 ------------------------------ */

export interface MermaidEdit {
  /** 打开那一刻的源码 */
  code: string;
  /** 面板点「完成」时把新源码写回块里 */
  apply: (next: string) => void;
  /**
   * 把这一块换成嵌套列表。只有思维导图才给 —— 流程图转成列表没有意义。
   * 面板据此决定要不要显示「转成列表」那个按钮。
   */
  toList?: () => void;
}

/**
 * 正在编辑的那一块；null = 面板关着。
 * NodeView 是纯 TS（拿不到 Vue 组件），面板是 Vue 浮层，两者用这一份状态接上。
 */
export const mermaidEdit = shallowRef<MermaidEdit | null>(null);

/* ------------------------------ 主题切换 ------------------------------ */

/** 主题一换，所有图都要重画（缓存按主题分了桶，重算即可） */
const repaints = new Set<() => void>();
let watching = false;

function watchTheme(): void {
  if (watching) return;
  watching = true;
  new MutationObserver(() => {
    cache.clear();
    for (const repaint of repaints) repaint();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ------------------------------ NodeView ------------------------------ */

/**
 * 非 mermaid 的代码块：保持预设原来那副样子（`<pre data-language><code>`）。
 * 接管 code_block 就得管全部，这一条不能少。
 */
function plainCode(node: Node): NodeView {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.append(code);

  const sync = (next: Node): void => {
    const language = String(next.attrs.language ?? '');
    if (language) pre.setAttribute('data-language', language);
    else pre.removeAttribute('data-language');
  };
  sync(node);

  return {
    dom: pre,
    contentDOM: code,
    update: (next) => {
      if (next.type !== node.type) return false;
      sync(next);
      return true;
    },
  };
}

function mermaidBlock(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('div');
  dom.className = 'donote-mermaid';
  dom.contentEditable = 'false';
  dom.setAttribute('role', 'button');
  dom.setAttribute('tabindex', '0');
  dom.setAttribute('aria-label', '思维导图：点击编辑源码');
  dom.title = '点击编辑源码';

  let code = node.textContent;
  /** 渲染是异步的，用序号丢弃「渲染期间源码又变了」的那一次结果 */
  let token = 0;

  const paint = async (): Promise<void> => {
    const mine = (token += 1);
    dom.classList.remove('is-error');
    dom.textContent = '正在渲染思维导图…';
    const result = await renderMermaid(code);
    if (mine !== token) return;
    if (result.error) {
      dom.classList.add('is-error');
      dom.textContent = result.error;
      return;
    }
    dom.innerHTML = result.svg ?? '';
  };

  /** 面板里改完 → 一次事务换掉块内容。节点还是 code_block，落盘还是 ```mermaid */
  const write = (next: string): void => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.textContent === next) return;
    const tr = view.state.tr.replaceWith(
      pos + 1,
      pos + 1 + current.content.size,
      next ? view.state.schema.text(next) : [],
    );
    view.dispatch(tr);
  };

  /**
   * 导图 → 嵌套列表。面板底部的「转成列表」用它。
   * 读的是**块的当前内容**而不是面板里的草稿 —— 调用方会先把草稿写回去再调它。
   */
  const toList = (): void => {
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const current = view.state.doc.nodeAt(pos);
    if (!current) return;
    const tree = parseMindmap(current.textContent);
    if (!tree) return;
    const list = mermaidToBulletList(view.state.schema, tree);
    if (!list) return;
    view.dispatch(view.state.tr.replaceWith(pos, pos + current.nodeSize, list).scrollIntoView());
    view.focus();
  };

  const open = (): void => {
    // 只读（回收站里的笔记）不给编辑入口
    if (!view.editable) return;
    mermaidEdit.value = { code, apply: write, toList };
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') open();
  };

  dom.addEventListener('click', open);
  dom.addEventListener('keydown', onKey);
  watchTheme();
  repaints.add(paint);
  void paint();

  return {
    dom,
    // 里面全是渲染出来的 SVG，不是可编辑内容；变更一律不往 ProseMirror 里报
    ignoreMutation: () => true,
    // 点击 / 选择交给上面那个监听：别让 ProseMirror 把光标塞进一个不可编辑的块
    stopEvent: () => true,
    selectNode: () => dom.classList.add('is-selected'),
    deselectNode: () => dom.classList.remove('is-selected'),
    update: (next) => {
      // 语言被改掉（mermaid → 别的）时让 ProseMirror 重建视图，这里不接
      if (next.type !== node.type || next.attrs.language !== MERMAID_LANG) return false;
      if (next.textContent !== code) {
        code = next.textContent;
        void paint();
      }
      return true;
    },
    destroy: () => {
      repaints.delete(paint);
      dom.removeEventListener('click', open);
      dom.removeEventListener('keydown', onKey);
    },
  };
}

/**
 * code_block 的 NodeView。两种语言两种长相，所以工厂里先分流：
 * mermaid → 只出图；其余 → 原样的 `<pre><code>`。
 */
export const mermaid = $view(
  codeBlockSchema.node,
  () => (node, view, getPos) =>
    node.attrs.language === MERMAID_LANG ? mermaidBlock(node, view, getPos) : plainCode(node),
);
