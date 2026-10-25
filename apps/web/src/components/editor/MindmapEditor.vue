<script setup lang="ts">
/**
 * 思维导图的可视化编辑器（弹窗里的「可视化」模式）。
 *
 * 只做一件事：把一棵 `MindNode` 树画出来，让人用鼠标和键盘改它，改完把新树丢回去。
 * 数据格式、序列化、和 mermaid 文本的互转都在 `mindmap.ts`，这里不碰。
 *
 * 为什么不用现成的图库：这一层 UI 只有「节点 + 连线 + 拖拽」，自己画一百多行就够，
 * 换来的好处是节点样式跟着应用主题走、序列化逻辑只有一份、不额外吃一个依赖的体积。
 */
import { computed, nextTick, ref, watch } from 'vue';
import {
  addChild,
  addSibling,
  layout,
  removeNode,
  reparent,
  setText,
  type MindNode,
} from './mindmap';

const props = defineProps<{ tree: MindNode }>();
const emit = defineEmits<{ 'update:tree': [MindNode] }>();

const NODE_W = 168;
const NODE_H = 38;
const COL = 232;
const ROW = 58;

const canvas = ref<HTMLElement | null>(null);
const selectedId = ref<string>(props.tree.id);
/**
 * 画布的平移与缩放（Xmind 那种手感）：
 * 滚轮上下平移、`Ctrl`+滚轮以光标为中心缩放、按住空白处拖动画布。
 * 节点位置始终由布局算，不让人自由摆放 —— 自由摆放的导图很快会变成一团线。
 */
const zoom = ref(1);
const pan = ref({ x: 20, y: 16 });
const panning = ref(false);
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const editingId = ref<string | null>(null);
const editText = ref('');
const dragId = ref<string | null>(null);
const dropId = ref<string | null>(null);
/**
 * 正在编辑的那个输入框。
 * 🔴 不能用 `ref="input"`：节点是 v-for 出来的，模板 ref 会变成元素数组，
 * 拿到的不是 HTMLInputElement（`focus is not a function`，探针抓到过）。
 */
let editingInput: HTMLInputElement | null = null;

const map = computed(() => layout(props.tree));

const boxes = computed(() =>
  map.value.placed.map((item) => ({
    node: item.node,
    x: item.depth * COL,
    y: item.row * ROW,
    selected: item.node.id === selectedId.value,
    dropTarget: item.node.id === dropId.value,
  })),
);

const links = computed(() => {
  const at = new Map(boxes.value.map((box) => [box.node.id, box]));
  const out: Array<{ id: string; d: string }> = [];
  const walk = (node: MindNode): void => {
    const from = at.get(node.id);
    for (const child of node.children) {
      const to = at.get(child.id);
      if (from && to) {
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        out.push({ id: `${node.id}-${child.id}`, d: `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
      }
      walk(child);
    }
  };
  walk(props.tree);
  return out;
});

const size = computed(() => ({
  // 右边多留一截：最右一层的节点贴着边框看起来像是被切掉的
  width: (map.value.depth + 1) * COL + 24,
  height: Math.max(map.value.rows * ROW, ROW),
}));

const stageStyle = computed(() => ({
  width: `${size.value.width}px`,
  height: `${size.value.height}px`,
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
}));

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/** 以画布上某一点为中心缩放：光标底下的那个节点缩放前后不动 */
function zoomAt(next: number, pointX: number, pointY: number): void {
  const target = clampZoom(next);
  const ratio = target / zoom.value;
  pan.value = {
    x: pointX - (pointX - pan.value.x) * ratio,
    y: pointY - (pointY - pan.value.y) * ratio,
  };
  zoom.value = target;
}

function zoomBy(delta: number): void {
  const box = canvas.value?.getBoundingClientRect();
  if (!box) return;
  zoomAt(zoom.value + delta, box.width / 2, box.height / 2);
}

/** 适应窗口：整棵树塞进画布，并居中 */
function fitToWindow(): void {
  const box = canvas.value?.getBoundingClientRect();
  if (!box) return;
  const pad = 36;
  const next = clampZoom(
    Math.min(1, (box.width - pad) / size.value.width, (box.height - pad) / size.value.height),
  );
  zoom.value = next;
  pan.value = {
    x: Math.max(pad / 2, (box.width - size.value.width * next) / 2),
    y: Math.max(pad / 2, (box.height - size.value.height * next) / 2),
  };
}

function onWheel(event: WheelEvent): void {
  const box = canvas.value?.getBoundingClientRect();
  if (!box) return;
  if (event.ctrlKey || event.metaKey) {
    // 触控板双指捏合同样走 ctrlKey，正好一套逻辑
    const step = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(zoom.value * step, event.clientX - box.left, event.clientY - box.top);
    return;
  }
  pan.value = {
    x: pan.value.x - event.deltaX,
    y: pan.value.y - event.deltaY,
  };
}

/** 按住空白处平移。节点上的按下要留给拖拽换父级，这里直接放行 */
function startPan(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.node') || event.button !== 0) return;
  panning.value = true;
  const startX = event.clientX;
  const startY = event.clientY;
  const origin = { ...pan.value };
  const move = (moveEvent: MouseEvent): void => {
    pan.value = {
      x: origin.x + (moveEvent.clientX - startX),
      y: origin.y + (moveEvent.clientY - startY),
    };
  };
  const up = (): void => {
    panning.value = false;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

watch(
  () => props.tree,
  () => {
    // 选中的节点被删掉了就回到根，别让键盘操作打在一个不存在的节点上
    if (!boxes.value.some((box) => box.node.id === selectedId.value)) {
      selectedId.value = props.tree.id;
    }
  },
);

function commit(next: MindNode): void {
  emit('update:tree', next);
}

function select(id: string): void {
  selectedId.value = id;
  canvas.value?.focus();
}

function startEdit(id: string): void {
  const box = boxes.value.find((item) => item.node.id === id);
  if (!box) return;
  selectedId.value = id;
  editingId.value = id;
  editText.value = box.node.text;
  void nextTick(() => {
    editingInput?.focus();
    editingInput?.select();
  });
}

function finishEdit(): void {
  const id = editingId.value;
  if (!id) return;
  editingId.value = null;
  if (editText.value.trim() !== '') commit(setText(props.tree, id, editText.value));
  canvas.value?.focus();
}

function cancelEdit(): void {
  editingId.value = null;
  canvas.value?.focus();
}

function onAddChild(): void {
  const { tree, added } = addChild(props.tree, selectedId.value);
  commit(tree);
  selectedId.value = added;
  void nextTick(() => startEdit(added));
}

function onAddSibling(): void {
  const { tree, added } = addSibling(props.tree, selectedId.value);
  commit(tree);
  selectedId.value = added;
  void nextTick(() => startEdit(added));
}

function onRemove(): void {
  if (selectedId.value === props.tree.id) return; // 根节点不给删
  const next = removeNode(props.tree, selectedId.value);
  selectedId.value = props.tree.id;
  commit(next);
}

/** 记下当前那个输入框（模板 ref 会在元素卸载时传 null） */
function setInputRef(el: unknown): void {
  editingInput = el instanceof HTMLInputElement ? el : null;
}

/** 输入框里的按键全留在输入框：冒泡到画布会把「回车确认」当成「加同级」 */
function onEditKey(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Enter') {
    event.preventDefault();
    finishEdit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEdit();
  }
}

function onKey(event: KeyboardEvent): void {
  if (editingId.value) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    onAddChild();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    onAddSibling();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    onRemove();
  } else if (event.key === 'F2') {
    event.preventDefault();
    startEdit(selectedId.value);
  }
}

/* ─────────────── 拖拽换父级 ─────────────── */

function onDragStart(id: string, event: DragEvent): void {
  dragId.value = id;
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(id: string, event: DragEvent): void {
  if (!dragId.value || dragId.value === id) return;
  event.preventDefault();
  dropId.value = id;
}

function onDrop(id: string): void {
  const from = dragId.value;
  dropId.value = null;
  dragId.value = null;
  if (!from || from === id) return;
  commit(reparent(props.tree, from, id));
  selectedId.value = from;
  canvas.value?.focus();
}

function onDragEnd(): void {
  dragId.value = null;
  dropId.value = null;
}
</script>

<template>
  <div class="mind">
    <div class="bar">
      <button type="button" class="chip" @click="onAddChild">加子节点</button>
      <button type="button" class="chip" @click="onAddSibling">加同级</button>
      <button
        type="button"
        class="chip"
        :disabled="selectedId === tree.id"
        @click="onRemove"
      >
        删除
      </button>

      <span class="sep" />

      <!-- 缩放：滚轮平移、Ctrl+滚轮缩放，这两个按钮给不知道快捷键的人 -->
      <button type="button" class="chip is-square" title="缩小（Ctrl+滚轮）" @click="zoomBy(-0.1)">−</button>
      <span class="zoom">{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="chip is-square" title="放大（Ctrl+滚轮）" @click="zoomBy(0.1)">+</button>
      <button type="button" class="chip" title="把整棵树放进画布" @click="fitToWindow">适应窗口</button>
    </div>

    <div
      ref="canvas"
      class="canvas"
      :class="{ 'is-panning': panning }"
      tabindex="0"
      role="tree"
      aria-label="思维导图画布"
      @keydown="onKey"
      @wheel.prevent="onWheel"
      @mousedown="startPan"
    >
      <div class="stage" :style="stageStyle">
        <svg class="links" :width="size.width" :height="size.height" aria-hidden="true">
          <path v-for="link in links" :key="link.id" :d="link.d" fill="none" />
        </svg>

        <div
          v-for="box in boxes"
          :key="box.node.id"
          class="node"
          :class="{ 'is-selected': box.selected, 'is-drop': box.dropTarget }"
          :style="{ left: `${box.x}px`, top: `${box.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :title="box.node.text"
          draggable="true"
          role="treeitem"
          :aria-selected="box.selected"
          @click="select(box.node.id)"
          @dblclick.stop="startEdit(box.node.id)"
          @dragstart.stop="onDragStart(box.node.id, $event)"
          @dragover="onDragOver(box.node.id, $event)"
          @dragleave="dropId = null"
          @drop.prevent.stop="onDrop(box.node.id)"
          @dragend="onDragEnd"
        >
          <input
            v-if="editingId === box.node.id"
            :ref="setInputRef"
            v-model="editText"
            class="edit"
            type="text"
            @click.stop
            @keydown="onEditKey"
            @blur="finishEdit"
          />
          <span v-else class="text">{{ box.node.text || '（空）' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mind {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: var(--sp-1);
}

.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
}

.chip {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
}

.chip:hover:not(:disabled) {
  background: var(--accent-soft);
}

.chip:disabled {
  opacity: 0.45;
  cursor: default;
}

.chip.is-square {
  width: 28px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
}

/* 把右侧的缩放控件推到另一头，左边是「改结构」、右边是「改视角」 */
.sep {
  flex: 1 1 auto;
}

.zoom {
  min-width: 40px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* 画布本身是一个「视口」：里面那张舞台整块变换，滚动条交给平移而不是原生滚动 */
.canvas {
  position: relative;
  flex: 1 1 auto;
  min-height: 280px;
  overflow: hidden;
  border-radius: var(--r-sm);
  background: var(--bg);
  border: 1px solid var(--surface-border);
  outline: none;
  cursor: grab;
  /* 画布上不要选中文字：拖画布时选中一片蓝底很难看 */
  user-select: none;
}

.canvas.is-panning {
  cursor: grabbing;
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.links {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
}

.links path {
  stroke: var(--surface-border);
  stroke-width: 1.6;
}

.node {
  position: absolute;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-1);
  font-size: var(--fs-sm);
  cursor: grab;
  user-select: none;
}

.node.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* 拖到哪个节点上就把哪个节点标出来 —— 不然松手前不知道会挂到谁下面 */
.node.is-drop {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.edit {
  width: 100%;
  height: 26px;
  padding: 0 4px;
  border-radius: var(--r-xs);
  border: 1px solid var(--accent);
  background: var(--bg);
  font-size: var(--fs-sm);
  color: var(--text);
}
</style>
