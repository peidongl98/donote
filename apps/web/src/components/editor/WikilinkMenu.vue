<script setup lang="ts">
/**
 * `[[` 笔记链接的补全菜单。
 *
 * 和 SlashMenu 同一套做法（不引 TipTap suggestion）：盯编辑器 DOM 的事件，
 * 每次从**光标前那段文字**重新解析出「`[[` + 查询词」，所以退格、粘贴、撤销都自然跟上。
 *
 * 与 SlashMenu 的两处不同：
 * - 查询词允许空格（笔记名里有空格），所以用 `[^[\]\n]*` 而不是 `\S*`。
 * - 候选不是固定命令表，而是**所有笔记名**（来自 titleIndex），模糊匹配后列出；
 *   没有同名笔记时多出一行「创建『X』」，选中即建。
 *
 * 落盘只插 `[[名字]]` 这五个字符的原文，不插路径 —— 笔记改名 / 搬家后引用不失效（见 storage/notes.ts）。
 *
 * 键位：↑↓ 选，回车 / Tab 选中，Esc 关闭。菜单开着时这几个键在**捕获阶段**拦下来，
 * 否则会被 ProseMirror 的 keymap 先吃掉（回车会变成换行）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Editor } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { editorViewCtx } from '@milkdown/kit/core';
import { listenerCtx } from '@milkdown/kit/plugin/listener';

const props = defineProps<{
  editor: Editor | null;
  /** 笔记名 → 笔记 id。菜单只用来列候选，不解析链接（那件事在 wikilink.ts 的插件里） */
  titleIndex: Record<string, string>;
}>();

const emit = defineEmits<{
  /** 选中了「创建『X』」——插入正文之外还要真的把这篇建出来 */
  create: [name: string];
}>();

interface Row {
  kind: 'note' | 'create';
  title: string;
}

const MENU_W = 240;
const MAX_ROWS = 12;

const open = ref(false);
const query = ref('');
const active = ref(0);
const top = ref(0);
const left = ref(0);
/** 「[[查询」在文档里的范围，选中后要整体换掉 */
const range = ref({ from: 0, to: 0 });

const rows = computed<Row[]>(() => {
  const q = query.value.trim();
  const all = Object.keys(props.titleIndex);
  const hit = q
    ? all.filter((title) => title.toLowerCase().includes(q.toLowerCase()))
    : all;
  const out: Row[] = hit
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .slice(0, MAX_ROWS)
    .map((title) => ({ kind: 'note' as const, title }));
  // 没有同名笔记才给「创建」——已经有那一篇时，写进去的就是链接
  if (q && !props.titleIndex[q]) out.unshift({ kind: 'create', title: q });
  return out;
});

let detach: (() => void) | null = null;
/** 建编辑器时拿到的视图。**同步**读它，不走 editor.action（异步队列会慢一拍） */
let view: EditorView | null = null;
/** Esc 关掉之后别被 keyup 立刻重新打开 —— 记下被关掉的那个 `[[` 的位置 */
let dismissedAt = -1;

function close(): void {
  open.value = false;
  query.value = '';
  active.value = 0;
}

/** 从「光标前那段文字」里解析 `[[查询`；解析不到就把菜单收起来 */
function readTrigger(): { from: number; to: number; query: string } | null {
  const state = view?.state;
  if (!state) return null;
  const { selection } = state;
  const $from = selection.$from;
  // 代码块里不打补全（那里 `[[` 多半是代码）
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name === 'code_block') {
    return null;
  }
  const text = $from.parent.textContent.slice(0, $from.parentOffset);
  const hit = /\[\[([^[\]\n]*)$/.exec(text);
  if (!hit) return null;
  return { from: $from.start() + hit.index, to: $from.pos, query: hit[1] };
}

function sync(): void {
  const hit = readTrigger();
  if (!hit) {
    dismissedAt = -1;
    return close();
  }
  if (dismissedAt === hit.from) return close();

  if (hit.query !== query.value) active.value = 0;
  query.value = hit.query;
  range.value = { from: hit.from, to: hit.to };

  // 贴着光标下方弹（fixed 定位，不受正文 overflow 影响）
  const coords = view!.coordsAtPos(hit.to);
  left.value = Math.min(Math.max(coords.left, 8), window.innerWidth - MENU_W - 8);
  top.value = Math.min(coords.bottom + 6, window.innerHeight - 8);
  open.value = true;
}

function confirm(row: Row | undefined): void {
  if (!row) return;
  // 落点以**当前**选区为准；删除与插入放进同一个事务，顺序是确定的
  const hit = readTrigger() ?? range.value;
  const name = row.title.trim();
  close();
  if (!view || !name) return;
  if (hit.to < hit.from || hit.to > view.state.doc.content.size) return;
  view.dispatch(view.state.tr.insertText(`[[${name}]]`, hit.from, hit.to));
  view.focus();
  if (row.kind === 'create') emit('create', name);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!open.value) return;
  const list = rows.value;
  switch (event.key) {
    case 'ArrowDown':
      active.value = list.length ? (active.value + 1) % list.length : 0;
      break;
    case 'ArrowUp':
      active.value = list.length ? (active.value - 1 + list.length) % list.length : 0;
      break;
    case 'Enter':
    case 'Tab':
      confirm(list[active.value]);
      break;
    case 'Escape':
      dismissedAt = range.value.from;
      close();
      break;
    default:
      return;
  }
  // 捕获阶段拦下：不然回车会先被 ProseMirror 的 keymap 当成换行
  event.preventDefault();
  event.stopPropagation();
}

function onOutside(event: MouseEvent): void {
  if (!open.value) return;
  const el = event.target as HTMLElement | null;
  if (el?.closest('.wikilink-menu')) return;
  dismissedAt = range.value.from;
  close();
}

function attach(editor: Editor | null): void {
  detach?.();
  detach = null;
  view = null;
  if (!editor) return;

  void editor.action((ctx) => {
    const instance = ctx.get(editorViewCtx);
    const dom = instance?.dom as HTMLElement | undefined;
    if (!instance || !dom) return;
    view = instance;

    // 🔴 不能只听 DOM 的 input/keyup：ProseMirror 处理 DOM 变更是**异步**的，
    // 在 input 回调里读 view.state 会少掉最后一个字。走 listener 的
    // updated / selectionUpdated，这两个是在事务落地之后才发的。
    const bus = ctx.get(listenerCtx);
    bus.updated(() => sync());
    bus.selectionUpdated(() => sync());

    dom.addEventListener('keydown', onKeyDown, true);
    dom.addEventListener('blur', close);
    window.addEventListener('mousedown', onOutside, true);

    detach = () => {
      dom.removeEventListener('keydown', onKeyDown, true);
      dom.removeEventListener('blur', close);
      window.removeEventListener('mousedown', onOutside, true);
      view = null;
    };
  });
}

watch(() => props.editor, attach, { immediate: true });
onBeforeUnmount(() => detach?.());
</script>

<template>
  <div
    v-if="open && rows.length"
    class="wikilink-menu"
    role="listbox"
    aria-label="链接到笔记"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${MENU_W}px` }"
  >
    <button
      v-for="(row, i) in rows"
      :key="`${row.kind}:${row.title}`"
      type="button"
      class="wikilink-item"
      :class="{ 'is-active': i === active, 'is-create': row.kind === 'create' }"
      role="option"
      :aria-selected="i === active"
      @mousedown.prevent
      @mouseenter="active = i"
      @click="confirm(row)"
    >
      <span class="wikilink-icon" aria-hidden="true">{{ row.kind === 'create' ? '＋' : '📄' }}</span>
      <span class="wikilink-label">{{ row.kind === 'create' ? `创建「${row.title}」` : row.title }}</span>
    </button>
  </div>
</template>

<style scoped>
.wikilink-menu {
  position: fixed;
  z-index: 16;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-3);
}

.wikilink-item {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--r-xs);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text);
}

.wikilink-item.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.wikilink-item.is-create {
  color: var(--accent);
}

.wikilink-icon {
  flex: none;
  font-size: 12px;
  opacity: 0.85;
}

.wikilink-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
