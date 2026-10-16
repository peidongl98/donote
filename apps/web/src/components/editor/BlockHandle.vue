<script setup lang="ts">
/**
 * 块级手柄：鼠标悬停在任意块上时，在该块左侧出现 ⋮⋮。
 * - 点一下 → 弹菜单：删除本块 / 复制本块 / 转为（文本、标题 1–3、引用、代码块、无序 / 有序列表）
 * - 按住拖 → 把这一整块挪到别的块之间（落点有指示线）
 *
 * 三条实现约束：
 * 1. **必须 `position: fixed`**。正文的滚动容器（`.donote-surface`）是 `overflow-y: auto`，
 *    手柄若作为它的子元素会被裁掉（另一轴会一并变成 auto），所以按视口坐标定位、滚动时收起。
 * 2. 手柄在正文盒子之外，鼠标从块移到手柄的途中会离开正文 → 不能「一离开就收」，
 *    要留一个短暂延迟，手柄自己的 mouseenter 会把它取消掉。
 * 3. 拖动走**指针事件自己算落点**，不用 HTML5 drag-and-drop：
 *    拖的是「文档里的一个块」而不是一段 DOM，落点必须由 `posAtCoords` 换算成文档位置，
 *    而且一次拖放要在**一个事务**里删+插（一次撤销回到原位）—— 这些 DnD 都给不了。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import { convertBlockAt, deleteBlockAt, duplicateBlockAt, moveBlock, type BlockKind } from './commands';

const props = defineProps<{ editor: Editor | null }>();

/** 手柄宽度，用来把它摆到正文左边 */
const HANDLE_W = 22;
/** 菜单宽度，用来夹住不越出右边界 */
const MENU_W = 200;
/** 超过这个位移才算拖动，否则当点按（不然手一抖菜单就开不出来） */
const DRAG_SLOP = 4;

const visible = ref(false);
const menuOpen = ref(false);
const top = ref(0);
const left = ref(0);
/** 当前指向的顶层块起点 */
const blockStart = ref(-1);

/** 拖动中（指针按下并已越过阈值） */
const dragging = ref(false);
/** 落点所在的块边界（文档位置）；null = 指针不在正文上 */
const dropAt = ref<number | null>(null);
/** 落点指示线的视口位置 */
const dropLine = ref<{ top: number; left: number; width: number } | null>(null);

const CONVERT: Array<{ kind: BlockKind; label: string }> = [
  { kind: 'paragraph', label: '文本' },
  { kind: 'h1', label: '标题 1' },
  { kind: 'h2', label: '标题 2' },
  { kind: 'h3', label: '标题 3' },
  { kind: 'blockquote', label: '引用' },
  { kind: 'codeBlock', label: '代码块' },
  { kind: 'bullet', label: '无序列表' },
  { kind: 'ordered', label: '有序列表' },
];

let view: EditorView | null = null;
let detach: (() => void) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** 上一次见到的指针坐标：Manhattan 位移 <2px 视为「没动」（挡滚动后补发的同坐标 mousemove） */
let last = { x: -1, y: -1 };
/** 最近一次滚动时刻：滚动后 150ms 内不点亮手柄 */
let scrolledAt = 0;

/* ------------------------------- 悬停 / 收起 ------------------------------- */

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** 收起手柄。菜单开着、正在拖动时不收（否则鼠标一移开，锚点就没了） */
function scheduleHide(): void {
  cancelHide();
  if (menuOpen.value || dragging.value) return;
  hideTimer = setTimeout(() => {
    if (!menuOpen.value && !dragging.value) visible.value = false;
  }, 240);
}

function hideNow(): void {
  cancelHide();
  visible.value = false;
  menuOpen.value = false;
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && menuOpen.value) hideNow();
}

function onOutside(event: MouseEvent): void {
  if (!menuOpen.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.block-handle, .block-menu')) return;
  hideNow();
}

/* --------------------------------- 拖动 --------------------------------- */

/** 按下起点（判断点按还是拖动） */
let press: { x: number; y: number } | null = null;
/** 按下的那一块。拖动全程用它 —— 手柄往正文里挪的途中，`mousemove` 可能已经把
 *  `blockStart` 换成别的块了（阈值以下还不算拖动），不冻结就会挪错块 */
let dragFrom = -1;
/** 拖完紧跟的那次 click 要吞掉（否则松手就弹菜单） */
let suppressClick = false;
/** 顶层块边界的位置表，按文档对象缓存（拖动期间文档不会变） */
let offsetsCache: { doc: unknown; list: number[] } | null = null;

/**
 * 往上找第一个能滚的祖先。
 * 不能直接用 `dom.parentElement`：ProseMirror 的父元素是 Milkdown 的 `.milkdown` 外壳
 * （`overflow: visible`），真正滚的是更外层的 `.donote-surface`；监听挂错节点就永远收不到 scroll。
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let cur = el.parentElement;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}

function offsetsOf(v: EditorView): number[] {
  const doc = v.state.doc;
  if (offsetsCache?.doc === doc) return offsetsCache.list;
  const list = [0];
  doc.forEach((child) => list.push(list[list.length - 1] + child.nodeSize));
  offsetsCache = { doc, list };
  return list;
}

/**
 * 指针落在哪两个块之间。横向不管（块是整行的），只看纵向在目标块的哪半截。
 * 返回的 `pos` 是**当前文档**里的块边界位置，直接交给 `moveBlock`。
 */
function boundaryFor(
  v: EditorView,
  clientX: number,
  clientY: number,
): { pos: number; line: { top: number; left: number; width: number } } | null {
  const hit = v.posAtCoords({ left: clientX, top: clientY });
  if (!hit) return null;
  const doc = v.state.doc;
  const offsets = offsetsOf(v);
  const $pos = doc.resolve(Math.min(hit.pos, doc.content.size));
  const index = Math.min($pos.index(0), doc.childCount - 1);
  const el = v.nodeDOM(offsets[index]);
  if (!(el instanceof HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  const after = clientY > rect.top + rect.height / 2;
  const box = (v.dom as HTMLElement).getBoundingClientRect();
  return {
    pos: offsets[after ? index + 1 : index],
    line: { top: after ? rect.bottom : rect.top, left: box.left, width: box.width },
  };
}

function onPointerMove(event: PointerEvent): void {
  if (!press || !view) return;
  if (!dragging.value) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
    dragging.value = true;
    menuOpen.value = false;
    cancelHide();
  }
  const hit = boundaryFor(view, event.clientX, event.clientY);
  dropAt.value = hit ? hit.pos : null;
  dropLine.value = hit ? hit.line : null;
}

/** 拖动的收摊（Esc 取消 / 正常松手都走这里） */
function endDrag(): void {
  dragging.value = false;
  dropAt.value = null;
  dropLine.value = null;
  press = null;
  dragFrom = -1;
  offsetsCache = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('keydown', onDragEscape, true);
}

function onPointerUp(): void {
  const wasDragging = dragging.value;
  const target = dropAt.value;
  const from = dragFrom;
  endDrag();
  if (!wasDragging) return;
  suppressClick = true;
  visible.value = false; // 块挪走了，手柄留在原地没意义；鼠标一动会重新贴上去
  if (target !== null) moveBlock(props.editor, from, target);
}

function onDragEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !dragging.value) return;
  event.stopPropagation();
  endDrag();
  suppressClick = true;
  visible.value = false;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || blockStart.value < 0 || !view) return;
  suppressClick = false;
  dragFrom = blockStart.value;
  press = { x: event.clientX, y: event.clientY };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onDragEscape, true);
}

/* --------------------------------- 挂载 --------------------------------- */

function attach(editor: Editor | null): void {
  detach?.();
  detach = null;
  if (!editor) return;

  void editor.action((ctx) => {
    const instance = ctx.get(editorViewCtx);
    const dom = instance?.dom as HTMLElement | undefined;
    if (!instance || !dom) return;
    view = instance;
    const scroller = scrollParent(dom);

    const onMove = (event: MouseEvent): void => {
      // 从按下到松手，手柄钉在原地不动（拖动期间更要钉住，免得跟着指针乱跑）
      if (press) return;
      /*
       * 滚动不算「指针动过」。
       *
       * 滚轮 / 触控板滚动时，指针本身几乎没动，浏览器却会在滚动后补发一次 mousemove
       * （触控板两指滚动时指尖也会带出真实位移）。原来这一下会立刻把手柄点亮，位置按
       * 旧坐标算 —— 于是一个跟当前指针不相干的块冒出 ⋮⋮，还要等 mouseleave 的 240ms
       * 延时才收掉。改成两条：位移不到 2px 不算动；刚滚过 150ms 内不点亮。
       */
      const moved = Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y);
      last = { x: event.clientX, y: event.clientY };
      if (moved < 2) return;
      if (performance.now() - scrolledAt < 150) return;
      cancelHide();
      const hit = instance.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!hit) {
        if (!menuOpen.value) visible.value = false;
        return;
      }
      const $pos = instance.state.doc.resolve(hit.pos);
      // 只有顶层块（depth 1）才有手柄
      if ($pos.depth < 1) {
        if (!menuOpen.value) visible.value = false;
        return;
      }
      const start = $pos.before(1);
      const el = instance.nodeDOM(start);
      if (!(el instanceof HTMLElement)) {
        if (!menuOpen.value) visible.value = false;
        return;
      }
      const rect = el.getBoundingClientRect();
      blockStart.value = start;
      top.value = rect.top + 2;
      left.value = Math.max(4, rect.left - HANDLE_W - 2);
      visible.value = true;
    };

    const onScroll = (): void => {
      scrolledAt = performance.now();
      hideNow();
    };

    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', scheduleHide);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onEscape);
    window.addEventListener('mousedown', onOutside, true);

    detach = () => {
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', scheduleHide);
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('mousedown', onOutside, true);
      if (dragging.value || press) endDrag();
      view = null;
    };
  });
}

watch(() => props.editor, attach, { immediate: true });
onBeforeUnmount(() => {
  detach?.();
  cancelHide();
});

function toggleMenu(): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  menuOpen.value = !menuOpen.value;
}

function act(run: () => void): void {
  run();
  hideNow();
}

const menuLeft = (): number => Math.min(left.value + HANDLE_W + 4, window.innerWidth - MENU_W - 8);
const menuTop = (): number => Math.min(top.value, window.innerHeight - 260);
</script>

<template>
  <button
    v-if="visible"
    class="block-handle"
    :class="{ 'is-dragging': dragging }"
    type="button"
    aria-label="块操作"
    title="块操作（按住可拖动排序）"
    :style="{ top: `${top}px`, left: `${left}px` }"
    @mouseenter="cancelHide"
    @mouseleave="scheduleHide"
    @pointerdown="onPointerDown"
    @mousedown.prevent
    @click="toggleMenu"
  >
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.15" fill="currentColor" />
      <circle cx="7.5" cy="3" r="1.15" fill="currentColor" />
      <circle cx="2.5" cy="8" r="1.15" fill="currentColor" />
      <circle cx="7.5" cy="8" r="1.15" fill="currentColor" />
      <circle cx="2.5" cy="13" r="1.15" fill="currentColor" />
      <circle cx="7.5" cy="13" r="1.15" fill="currentColor" />
    </svg>
  </button>

  <!-- 拖动落点：一条品牌蓝细线，卡在目标块的上下缝里 -->
  <div
    v-if="dropLine"
    class="drop-line"
    :style="{
      top: `${dropLine.top - 1}px`,
      left: `${dropLine.left}px`,
      width: `${dropLine.width}px`,
    }"
  />

  <div
    v-if="menuOpen && blockStart >= 0"
    class="block-menu"
    role="menu"
    :style="{ top: `${menuTop()}px`, left: `${menuLeft()}px`, width: `${MENU_W}px` }"
    @mouseenter="cancelHide"
  >
    <button
      type="button"
      class="menu-item is-danger"
      role="menuitem"
      @mousedown.prevent
      @click="act(() => deleteBlockAt(editor, blockStart))"
    >
      删除本块
    </button>
    <button
      type="button"
      class="menu-item"
      role="menuitem"
      @mousedown.prevent
      @click="act(() => duplicateBlockAt(editor, blockStart))"
    >
      复制本块
    </button>

    <p class="menu-label">转为</p>
    <div class="menu-grid">
      <button
        v-for="option in CONVERT"
        :key="option.kind"
        type="button"
        class="menu-chip"
        role="menuitem"
        @mousedown.prevent
        @click="act(() => convertBlockAt(editor, blockStart, option.kind))"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.block-handle {
  position: fixed;
  z-index: 14;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 26px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  opacity: 0.55;
  cursor: grab;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth),
    opacity var(--dur-fast) var(--ease-smooth);
}

.block-handle:hover {
  background: var(--surface-2);
  color: var(--text);
  opacity: 1;
}

.block-handle.is-dragging {
  cursor: grabbing;
  background: var(--accent-soft);
  color: var(--accent);
  opacity: 1;
}

.drop-line {
  position: fixed;
  z-index: 16;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}

.block-menu {
  position: fixed;
  z-index: 15;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-3);
}

.menu-item {
  height: 30px;
  padding: 0 8px;
  border-radius: var(--r-xs);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.menu-item:hover {
  background: var(--accent-soft);
}

.menu-item.is-danger {
  color: var(--danger);
}

.menu-label {
  margin: 4px 0 0;
  padding: 4px 8px 0;
  border-top: 1px solid var(--divider);
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.menu-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}

.menu-chip {
  height: 28px;
  padding: 0 8px;
  border-radius: var(--r-xs);
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--text);
  background: var(--surface-2);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.menu-chip:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
