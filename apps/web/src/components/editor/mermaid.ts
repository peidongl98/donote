/**
 * 思维导图的预览。
 *
 * 文档里存的是**普通围栏代码块**（```mermaid），不是自定义节点：
 * 这样导出的 Markdown 是干净的，任何 Markdown 工具都能读，GitHub / 语雀也能直接渲染。
 * 预览只是编辑器里加的一层装饰（Decoration.widget），贴在代码块下面，不参与文档结构。
 *
 * Mermaid 本体约 1MB，只有在笔记里真的出现 mermaid 代码块时才动态 import。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

const MERMAID_LANG = 'mermaid';
const key = new PluginKey('donote-mermaid');

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

/** 渲染结果按「主题 + 源码」缓存，光标在别处动时不必重画 */
const cache = new Map<string, string>();

function keyOf(code: string): string {
  return `${themeOf()}\u0000${code}`;
}

let seq = 0;
/** 每个预览框各有一个防抖计时器；共用会互相取消 */
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function render(code: string, box: HTMLElement): void {
  const cacheKey = keyOf(code);
  const hit = cache.get(cacheKey);
  if (hit) {
    box.classList.remove('is-error');
    box.innerHTML = hit;
    return;
  }

  box.classList.remove('is-error');
  box.textContent = '正在渲染思维导图…';

  // 连续敲字时不每次都真渲染，停手 400ms 再算
  const pending = timers.get(box);
  if (pending) clearTimeout(pending);
  timers.set(
    box,
    setTimeout(async () => {
      const api = await loadMermaid();
      if (!api) {
        box.classList.add('is-error');
        box.textContent = '未能加载思维导图渲染器';
        return;
      }
      try {
        seq += 1;
        const { svg } = await api.render(`donote-mermaid-${seq}`, code);
        cache.set(cacheKey, svg);
        box.classList.remove('is-error');
        box.innerHTML = svg;
      } catch {
        box.classList.add('is-error');
        box.textContent = '思维导图语法有误，改一下上面的代码';
      }
    }, 400),
  );
}

function makeWidget(code: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'donote-mermaid';
  box.contentEditable = 'false';
  render(code, box);
  return box;
}

export const mermaid = $prose(
  () =>
    new Plugin({
      key,
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'code_block') return true;
            if (node.attrs.language !== MERMAID_LANG) return true;
            decos.push(
              Decoration.widget(pos + node.nodeSize, () => makeWidget(node.textContent), {
                side: 1,
                ignoreSelection: true,
              }),
            );
            return true;
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
      view(view: EditorView) {
        // 换主题要重画：清缓存 + 发一个空事务把装饰重算一遍
        const observer = new MutationObserver(() => {
          cache.clear();
          view.dispatch(view.state.tr.setMeta(key, Date.now()));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return {
          destroy: () => observer.disconnect(),
        };
      },
    }),
);
