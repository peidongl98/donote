<script setup lang="ts">
/**
 * `/` 命令菜单：在空行或段首打一个 `/`，弹块类型菜单。
 *
 * 做法不引依赖（没装 TipTap suggestion）：直接盯编辑器 DOM 的事件 + 选区文本。
 * 「查询词」不是自己存的，而是每次从**光标前那段文字**里重新解析出来
 * （`/(?:^|\s)\/(\S*)$/`），所以退格、粘贴、撤销都能自然跟上，不会出现两边不同步。
 *
 * 键位：↑↓ 选，回车 / Tab 执行，Esc 关闭。菜单开着时这几个键必须在**捕获阶段**拦下来，
 * 否则会被 ProseMirror 的 keymap 先吃掉（回车会变成换行）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Editor } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { listenerCtx } from '@milkdown/kit/plugin/listener';
import { editorViewCtx } from '@milkdown/kit/core';
import {
  insertFlowchart,
  insertHr,
  insertMermaid,
  insertMultiList,
  insertTable,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleCodeBlock,
  toggleOrderedList,
  toggleTaskList,
} from './commands';

const props = defineProps<{ editor: Editor | null }>();
const emit = defineEmits<{ 'pick-image': [] }>();

interface SlashItem {
  id: string;
  label: string;
  /** 搜索用的别名：英文名 + 拼音 + 常见叫法 */
  keys: string;
  run: () => void;
}

const MENU_W = 220;

const open = ref(false);
const query = ref('');
const active = ref(0);
const top = ref(0);
const left = ref(0);
/** 「/查询」在文档里的范围，选中命令后要抹掉 */
const range = ref({ from: 0, to: 0 });

const ITEMS = computed<SlashItem[]>(() => {
  const e = props.editor;
  return [
    { id: 'text', label: '文本', keys: 'text paragraph wenben zhengwen 正文 段落', run: () => setHeading(e, 0) },
    { id: 'h1', label: '标题 1', keys: 'h1 title heading biaoti 大标题', run: () => setHeading(e, 1) },
    { id: 'h2', label: '标题 2', keys: 'h2 title heading biaoti', run: () => setHeading(e, 2) },
    { id: 'h3', label: '标题 3', keys: 'h3 title heading biaoti', run: () => setHeading(e, 3) },
    { id: 'bullet', label: '无序列表', keys: 'ul bullet list wuxu liebiao 项目符号 圆点', run: () => toggleBulletList(e) },
    { id: 'ordered', label: '有序列表', keys: 'ol ordered list youxu bianhao 编号 数字', run: () => toggleOrderedList(e) },
    {
      id: 'multi',
      label: '多级列表',
      keys: 'multi level outline duojiliebiao duojiliebiao 大纲 层级 缩进 子项 嵌套',
      run: () => insertMultiList(e),
    },
    { id: 'task', label: '待办', keys: 'task todo checkbox daiban renwu 任务 清单 勾选', run: () => toggleTaskList(e) },
    { id: 'quote', label: '引用', keys: 'quote blockquote yinyong', run: () => toggleBlockquote(e) },
    { id: 'code', label: '代码块', keys: 'code block daimakuai daima 代码', run: () => toggleCodeBlock(e, false) },
    { id: 'hr', label: '分割线', keys: 'hr divider fengexian hengxian 横线', run: () => insertHr(e) },
    { id: 'table', label: '表格', keys: 'table biaoge', run: () => insertTable(e, 3, 3) },
    { id: 'image', label: '图片', keys: 'image img tupian zhaopian 照片 插图', run: () => emit('pick-image') },
    {
      id: 'mermaid',
      label: '思维导图',
      keys: 'mermaid mindmap siweidaotu naotu 脑图',
      run: () => insertMermaid(e),
    },
    {
      id: 'flowchart',
      label: '流程图',
      keys: 'flowchart graph liuchengtu liucheng 流程 连线 关系图',
      run: () => insertFlowchart(e),
    },
  ];
});

const shown = computed<SlashItem[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return ITEMS.value;
  return ITEMS.value.filter(
    (item) => item.label.toLowerCase().includes(q) || item.keys.includes(q),
  );
});

let detach: (() => void) | null = null;
/** 建编辑器时拿到的视图。**同步**读它，不走 editor.action（那是异步队列，
 *  会慢一拍：刚打完「/标题」就回车，删掉的还是上一次的「/标」）。 */
let view: EditorView | null = null;
/** Esc 关掉之后别被 keyup 立刻重新打开 —— 记下被关掉的那个 / 的位置 */
let dismissedAt = -1;

function close(): void {
  open.value = false;
  query.value = '';
  active.value = 0;
}

/** 从「光标前那段文字」里解析 `/查询`；解析不到就把菜单收起来 */
function readTrigger(): { from: number; to: number; query: string } | null {
  const state = view?.state;
  if (!state) return null;
  const { selection } = state;
  const $from = selection.$from;
  // 代码块里不打命令菜单
  if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name === 'code_block') return null;
  const text = $from.parent.textContent.slice(0, $from.parentOffset);
  const hit = /(?:^|\s)\/(\S*)$/.exec(text);
  if (!hit) return null;
  const slash = text.lastIndexOf('/');
  return { from: $from.start() + slash, to: $from.pos, query: hit[1] };
}

function sync(): void {
  const hit = readTrigger();
  if (!hit) {
    dismissedAt = -1;
    return close();
  }
  // 同一个 `/` 被 Esc 关掉过 → 保持关闭，直到把 `/` 删掉重打（那时 from 会变）
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

function confirm(item: SlashItem | undefined): void {
  if (!item) return;
  // 落点以**当前**选区为准（不依赖上一次同步的结果）。
  // 🔴 抹掉「/查询」这句必须**同步 dispatch**：预设命令走的是 editor.action 异步队列，
  //    如果删除也排进队列，两者顺序不保证 —— 实测会慢一拍，删掉的是上一次的「/标」。
  const hit = readTrigger() ?? range.value;
  close();
  if (view && hit.to > hit.from && hit.to <= view.state.doc.content.size) {
    view.dispatch(view.state.tr.delete(hit.from, hit.to));
  }
  item.run();
}

function onKeyDown(event: KeyboardEvent): void {
  if (!open.value) return;
  const list = shown.value;
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
  if (el?.closest('.slash-menu')) return;
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

    // 🔴 不能只听 DOM 的 input/keyup：ProseMirror 处理 DOM 变更是**异步**的
    // （DOMObserver 攒一批再 flush），在 input 回调里读 view.state 会少掉最后一个字 ——
    // 实测「/表格」被当成「/表」，菜单里冒出一堆含「表」的无关项。
    // 走 Milkdown 的 updated / selectionUpdated，这两个是在事务落地之后才发的。
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
    v-if="open && shown.length"
    class="slash-menu"
    role="listbox"
    aria-label="插入"
    :style="{ top: `${top}px`, left: `${left}px`, width: `${MENU_W}px` }"
  >
    <button
      v-for="(item, i) in shown"
      :key="item.id"
      type="button"
      class="slash-item"
      role="option"
      :class="{ 'is-active': i === active }"
      :aria-selected="i === active"
      @mousedown.prevent
      @mouseenter="active = i"
      @click="confirm(item)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
.slash-menu {
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

.slash-item {
  height: 30px;
  padding: 0 9px;
  border-radius: var(--r-xs);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text);
}

.slash-item.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
