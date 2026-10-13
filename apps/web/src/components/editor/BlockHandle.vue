<script setup lang="ts">
/**
 * 块级手柄：鼠标悬停在任意块上时，在该块左侧出现 ⋮⋮，点击弹菜单。
 *
 * 菜单三项：删除本块 / 复制本块 / 转为（文本、标题 1–3、引用、代码块、无序 / 有序列表）。
 *
 * 两条实现约束：
 * 1. **必须 `position: fixed`**。正文的滚动容器（`.donote-surface`）是 `overflow-y: auto`，
 *    手柄若作为它的子元素会被裁掉（另一轴会一并变成 auto），所以按视口坐标定位、滚动时收起。
 * 2. 手柄在正文盒子之外，鼠标从块移到手柄的途中会离开正文 → 不能「一离开就收」，
 *    要留一个短暂延迟，手柄自己的 mouseenter 会把它取消掉。
 */
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx } from '@milkdown/kit/core';
import { convertBlockAt, deleteBlockAt, duplicateBlockAt, type BlockKind } from './commands';

const props = defineProps<{ editor: Editor | null }>();

/** 手柄宽度，用来把它摆到正文左边 */
const HANDLE_W = 22;
/** 菜单宽度，用来夹住不越出右边界 */
const MENU_W = 200;

const visible = ref(false);
const menuOpen = ref(false);
const top = ref(0);
const left = ref(0);
/** 当前指向的顶层块起点 */
const blockStart = ref(-1);

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

let detach: (() => void) | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function cancelHide(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** 收起手柄。菜单开着时不收（否则鼠标一移向菜单，锚点就没了） */
function scheduleHide(): void {
  cancelHide();
  if (menuOpen.value) return;
  hideTimer = setTimeout(() => {
    if (!menuOpen.value) visible.value = false;
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

function attach(editor: Editor | null): void {
  detach?.();
  detach = null;
  if (!editor) return;

  void editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const dom = view?.dom as HTMLElement | undefined;
    if (!dom) return;
    const scroller = (dom.parentElement ?? dom) as HTMLElement;

    const onMove = (event: MouseEvent): void => {
      cancelHide();
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!hit) {
        if (!menuOpen.value) visible.value = false;
        return;
      }
      const $pos = view.state.doc.resolve(hit.pos);
      // 只有顶层块（depth 1）才有手柄
      if ($pos.depth < 1) {
        if (!menuOpen.value) visible.value = false;
        return;
      }
      const start = $pos.before(1);
      const el = view.nodeDOM(start);
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

    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', scheduleHide);
    scroller.addEventListener('scroll', hideNow, { passive: true });
    window.addEventListener('keydown', onEscape);
    window.addEventListener('mousedown', onOutside, true);

    detach = () => {
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', scheduleHide);
      scroller.removeEventListener('scroll', hideNow);
      window.removeEventListener('keydown', onEscape);
      window.removeEventListener('mousedown', onOutside, true);
    };
  });
}

watch(() => props.editor, attach, { immediate: true });
onBeforeUnmount(() => {
  detach?.();
  cancelHide();
});

function toggleMenu(): void {
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
    type="button"
    aria-label="块操作"
    title="块操作"
    :style="{ top: `${top}px`, left: `${left}px` }"
    @mouseenter="cancelHide"
    @mouseleave="scheduleHide"
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
