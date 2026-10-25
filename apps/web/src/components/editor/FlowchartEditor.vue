<script setup lang="ts">
/**
 * 流程图的可视化编辑器（弹窗里的「可视化」模式）。
 *
 * 与思维导图那个画布的区别只有一条：**节点位置是人摆的，连线是人拉的**。
 * 所以这边没有布局函数，坐标直接存在 `FlowNode.x/y` 上（落盘为 `%% @pos` 注释）。
 *
 * 图上能做的事：
 * - 拖节点挪位置（松手才写回，拖动过程不产生中间态）
 * - 鼠标按住节点右边缘那个小圆点拖到另一个节点上 → 连一条线（任意两个节点之间都能连）
 * - 双击节点改字；双击连线写标签
 * - 选中连线后按 Delete 或点工具条上的「删除」把线去掉
 * - 滚轮平移、Ctrl+滚轮以光标为中心缩放、按住空白处拖画布
 */
import { computed, nextTick, ref, watch } from 'vue';
import {
  addEdge,
  addNode,
  bounds,
  edgeKey,
  moveNode,
  removeEdge,
  removeNode,
  setEdgeLabel,
  setNodeShape,
  setNodeText,
  type FlowDoc,
  type FlowEdge,
  type FlowNode,
  type FlowShape,
} from './flowchart';

const props = defineProps<{ doc: FlowDoc }>();
const emit = defineEmits<{ 'update:doc': [FlowDoc] }>();

const NODE_W = 150;
const NODE_H = 46;

const SHAPES: Array<{ value: FlowShape; label: string }> = [
  { value: 'rect', label: '方框' },
  { value: 'round', label: '圆角' },
  { value: 'stadium', label: '胶囊' },
  { value: 'diamond', label: '菱形' },
  { value: 'circle', label: '圆形' },
  { value: 'hex', label: '六边形' },
];
const canvas = ref<HTMLElement | null>(null);
const zoom = ref(1);
const pan = ref({ x: 20, y: 16 });
const panning = ref(false);
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;

const selection = ref<{ kind: 'node' | 'edge'; id: string } | null>(null);
const editingId = ref<string | null>(null);
const editText = ref('');
const editingEdge = ref<string | null>(null);
const edgeText = ref('');

/** 拖动中的节点位置：只在松手时落回数据，拖动过程不产生几十次撤销点 */
const dragging = ref<{ id: string; x: number; y: number } | null>(null);
/** 从某个节点拉出来的那条虚线；`to` 是跟随鼠标的临时坐标 */
const linking = ref<{ from: string; x: number; y: number } | null>(null);

let editingInput: HTMLInputElement | null = null;
let edgeInput: HTMLInputElement | null = null;

function setInputRef(el: unknown): void {
  editingInput = el instanceof HTMLInputElement ? el : null;
}

function setEdgeInputRef(el: unknown): void {
  edgeInput = el instanceof HTMLInputElement ? el : null;
}

const boxes = computed(() =>
  props.doc.nodes.map((node) => {
    const at = dragging.value?.id === node.id ? dragging.value : node;
    return {
      node,
      x: at.x,
      y: at.y,
      selected: selection.value?.kind === 'node' && selection.value.id === node.id,
      linkTarget: linking.value !== null && linking.value.from !== node.id,
    };
  }),
);

const size = computed(() => bounds(props.doc, NODE_W, NODE_H));

const stageStyle = computed(() => ({
  width: `${size.value.width}px`,
  height: `${size.value.height}px`,
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
}));

/* ───────────────────────── 连线几何 ───────────────────────── */

type Dir = 'r' | 'l' | 'u' | 'd';

interface Point {
  x: number;
  y: number;
  dir: Dir;
}

/** 从节点朝另一个节点的方向，在盒子的边上取一个点 —— 连线贴着边出去，不会从框里穿出来 */
function anchor(node: { x: number; y: number }, other: { x: number; y: number }): Point {
  const cx = node.x + NODE_W / 2;
  const cy = node.y + NODE_H / 2;
  const dx = other.x + NODE_W / 2 - cx;
  const dy = other.y + NODE_H / 2 - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const dir: Dir = dx >= 0 ? 'r' : 'l';
    return { x: cx + (dir === 'r' ? NODE_W / 2 + 2 : -NODE_W / 2 - 2), y: cy, dir };
  }
  const dir: Dir = dy >= 0 ? 'd' : 'u';
  return { x: cx, y: cy + (dir === 'd' ? NODE_H / 2 + 2 : -NODE_H / 2 - 2), dir };
}

function outOf(point: Point, distance: number): Point {
  const next = { ...point };
  if (point.dir === 'r') next.x += distance;
  else if (point.dir === 'l') next.x -= distance;
  else if (point.dir === 'd') next.y += distance;
  else next.y -= distance;
  return next;
}

/** 三次贝塞尔的 t=0.5 处 —— 连线标签就摆在那儿 */
function midpoint(a: Point, c1: Point, c2: Point, b: Point): { x: number; y: number } {
  const at = (p: number, q: number, r: number, s: number): number => 0.125 * p + 0.375 * q + 0.375 * r + 0.125 * s;
  return { x: at(a.x, c1.x, c2.x, b.x), y: at(a.y, c1.y, c2.y, b.y) };
}

interface EdgeShape {
  edge: FlowEdge;
  key: string;
  d: string;
  label: { x: number; y: number };
  selected: boolean;
}

const edges = computed<EdgeShape[]>(() => {
  const byId = new Map(boxes.value.map((box) => [box.node.id, box]));
  const out: EdgeShape[] = [];
  for (const edge of props.doc.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const a = anchor(from, to);
    const b = anchor(to, from);
    const c1 = outOf(a, 52);
    const c2 = outOf(b, 52);
    out.push({
      edge,
      key: edgeKey(edge),
      d: `M${a.x} ${a.y} C${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      label: midpoint(a, c1, c2, b),
      selected: selection.value?.kind === 'edge' && selection.value.id === edgeKey(edge),
    });
  }
  return out;
});

/** 拉线时那条虚线 */
const rubber = computed(() => {
  const from = linking.value;
  if (!from) return null;
  const box = boxes.value.find((item) => item.node.id === from.from);
  if (!box) return null;
  const cx = box.x + NODE_W;
  const cy = box.y + NODE_H / 2;
  const at = (p: number, q: number, r: number, s: number): number => 0.125 * p + 0.375 * q + 0.375 * r + 0.125 * s;
  const mx = cx + 52;
  const d = `M${cx} ${cy} C${mx} ${cy}, ${from.x - 52} ${from.y}, ${from.x} ${from.y}`;
  return { d, x: at(cx, mx, from.x - 52, from.x), y: at(cy, cy, from.y, from.y) };
});

/* ───────────────────────── 视图：平移与缩放 ───────────────────────── */

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

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

function fitToWindow(): void {
  const box = canvas.value?.getBoundingClientRect();
  if (!box) return;
  const pad = 36;
  const next = clampZoom(Math.min(1, (box.width - pad) / size.value.width, (box.height - pad) / size.value.height));
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
    const step = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(zoom.value * step, event.clientX - box.left, event.clientY - box.top);
    return;
  }
  pan.value = { x: pan.value.x - event.deltaX, y: pan.value.y - event.deltaY };
}

/** 屏幕坐标 → 舞台坐标（摆节点、算落点都用它） */
function toStage(clientX: number, clientY: number): { x: number; y: number } {
  const box = canvas.value?.getBoundingClientRect();
  if (!box) return { x: 0, y: 0 };
  return {
    x: (clientX - box.left - pan.value.x) / zoom.value,
    y: (clientY - box.top - pan.value.y) / zoom.value,
  };
}

function startPan(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.node') || event.button !== 0) return;
  selection.value = null;
  panning.value = true;
  const startX = event.clientX;
  const startY = event.clientY;
  const origin = { ...pan.value };
  const move = (moveEvent: MouseEvent): void => {
    pan.value = { x: origin.x + (moveEvent.clientX - startX), y: origin.y + (moveEvent.clientY - startY) };
  };
  const up = (): void => {
    panning.value = false;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/* ───────────────────────── 节点：拖动 / 改字 ───────────────────────── */

function selectNode(id: string): void {
  selection.value = { kind: 'node', id };
  canvas.value?.focus();
}

function startDrag(node: FlowNode, event: MouseEvent): void {
  if (event.button !== 0) return;
  if (editingId.value === node.id) return;
  event.stopPropagation();
  selectNode(node.id);

  const start = toStage(event.clientX, event.clientY);
  const origin = { x: node.x, y: node.y };
  let moved = false;

  const move = (moveEvent: MouseEvent): void => {
    const now = toStage(moveEvent.clientX, moveEvent.clientY);
    const dx = now.x - start.x;
    const dy = now.y - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    dragging.value = { id: node.id, x: Math.max(0, Math.round(origin.x + dx)), y: Math.max(0, Math.round(origin.y + dy)) };
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const at = dragging.value;
    dragging.value = null;
    if (moved && at && at.id === node.id) emit('update:doc', moveNode(props.doc, node.id, at.x, at.y));
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startEdit(node: FlowNode): void {
  selection.value = { kind: 'node', id: node.id };
  editingId.value = node.id;
  editText.value = node.text;
  void nextTick(() => {
    editingInput?.focus();
    editingInput?.select();
  });
}

function finishEdit(): void {
  const id = editingId.value;
  if (!id) return;
  editingId.value = null;
  if (editText.value.trim() !== '') emit('update:doc', setNodeText(props.doc, id, editText.value));
  canvas.value?.focus();
}

function cancelEdit(): void {
  editingId.value = null;
  canvas.value?.focus();
}

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

/* ───────────────────────── 连线：拉出来 / 改标签 / 删除 ───────────────────────── */

function startLink(node: FlowNode, event: MouseEvent): void {
  if (event.button !== 0) return;
  event.stopPropagation();
  const at = toStage(event.clientX, event.clientY);
  linking.value = { from: node.id, x: at.x, y: at.y };

  const move = (moveEvent: MouseEvent): void => {
    const now = toStage(moveEvent.clientX, moveEvent.clientY);
    if (linking.value) linking.value = { ...linking.value, x: now.x, y: now.y };
  };
  const up = (upEvent: MouseEvent): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const from = linking.value?.from;
    linking.value = null;
    if (!from) return;
    // 松手时鼠标底下是哪个节点 —— 用 elementFromPoint 而不是判坐标，省得自己算命中
    const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null;
    const target = under?.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (!target || target === from) return;
    emit('update:doc', addEdge(props.doc, from, target));
    selection.value = { kind: 'edge', id: `${from}->${target}` };
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function selectEdge(shape: EdgeShape): void {
  selection.value = { kind: 'edge', id: shape.key };
  canvas.value?.focus();
}

function startEdgeEdit(shape: EdgeShape): void {
  selection.value = { kind: 'edge', id: shape.key };
  editingEdge.value = shape.key;
  edgeText.value = shape.edge.label;
  void nextTick(() => {
    edgeInput?.focus();
    edgeInput?.select();
  });
}

function finishEdgeEdit(): void {
  const key = editingEdge.value;
  if (!key) return;
  editingEdge.value = null;
  const shape = edges.value.find((item) => item.key === key);
  if (!shape) return;
  emit('update:doc', setEdgeLabel(props.doc, shape.edge.from, shape.edge.to, edgeText.value));
  canvas.value?.focus();
}

function onEdgeKey(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Enter') {
    event.preventDefault();
    finishEdgeEdit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    editingEdge.value = null;
    canvas.value?.focus();
  }
}

/* ───────────────────────── 工具条动作 ───────────────────────── */

function onAddNode(): void {
  const at = selection.value;
  const spot = at?.kind === 'node' ? props.doc.nodes.find((node) => node.id === at.id) : null;
  // 🔴 落点不能压在已有节点上：重叠的时候「拖到某个节点上」会认错目标（上层那个永远先被点到）
  const bottom = props.doc.nodes.reduce((max, node) => Math.max(max, node.y), 0);
  const x = spot ? spot.x : 60;
  const y = spot ? spot.y + NODE_H + 56 : bottom + NODE_H + 56;
  const { doc, added } = addNode(props.doc, x, y);
  emit('update:doc', doc);
  selection.value = { kind: 'node', id: added };
  // 🔴 用返回的 doc 取节点，不回头读 props —— 父组件的 props 要到下一轮渲染才更新
  const node = doc.nodes.find((item) => item.id === added);
  if (node) void nextTick(() => startEdit(node));
}

/** 从选中的节点再接一个出来（比先加节点再连线少一步） */
function onAddNext(): void {
  const at = selection.value;
  if (at?.kind !== 'node') return;
  const from = props.doc.nodes.find((node) => node.id === at.id);
  if (!from) return;
  const { doc, added } = addNode(props.doc, from.x + 210, from.y);
  const linked = addEdge(doc, from.id, added);
  emit('update:doc', linked);
  selection.value = { kind: 'node', id: added };
  const node = linked.nodes.find((item) => item.id === added);
  if (node) void nextTick(() => startEdit(node));
}

function onRemove(): void {
  const at = selection.value;
  if (!at) return;
  if (at.kind === 'node') {
    emit('update:doc', removeNode(props.doc, at.id));
  } else {
    const [from, to] = at.id.split('->');
    emit('update:doc', removeEdge(props.doc, from, to));
  }
  selection.value = null;
  canvas.value?.focus();
}

function onShape(event: Event): void {
  const at = selection.value;
  if (at?.kind !== 'node') return;
  const shape = (event.target as HTMLSelectElement).value as FlowShape;
  emit('update:doc', setNodeShape(props.doc, at.id, shape));
}

const selectedShape = computed(() => {
  if (selection.value?.kind !== 'node') return '';
  return props.doc.nodes.find((node) => node.id === selection.value?.id)?.shape ?? '';
});

function onKey(event: KeyboardEvent): void {
  if (editingId.value || editingEdge.value) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (!selection.value) return;
    event.preventDefault();
    onRemove();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (selection.value?.kind === 'node') onAddNext();
    else onAddNode();
  } else if (event.key === 'F2') {
    const at = selection.value;
    if (at?.kind !== 'node') return;
    event.preventDefault();
    const node = props.doc.nodes.find((item) => item.id === at.id);
    if (node) startEdit(node);
  } else if (event.key === 'Escape') {
    selection.value = null;
  }
}

watch(
  () => props.doc,
  (doc) => {
    const at = selection.value;
    if (!at) return;
    const alive =
      at.kind === 'node'
        ? doc.nodes.some((node) => node.id === at.id)
        : doc.edges.some((edge) => edgeKey(edge) === at.id);
    if (!alive) selection.value = null;
  },
);
</script>

<template>
  <div class="flow">
    <div class="bar">
      <button type="button" class="chip" @click="onAddNode">加节点</button>
      <button type="button" class="chip" :disabled="selection?.kind !== 'node'" @click="onAddNext">接下一个</button>

      <select
        class="shape-pick"
        :value="selectedShape"
        :disabled="selection?.kind !== 'node'"
        aria-label="节点形状"
        @change="onShape"
      >
        <option value="" disabled>形状</option>
        <option v-for="shape in SHAPES" :key="shape.value" :value="shape.value">{{ shape.label }}</option>
      </select>

      <button type="button" class="chip" :disabled="!selection" @click="onRemove">删除</button>

      <span class="sep" />

      <button type="button" class="chip is-square" title="缩小（Ctrl+滚轮）" @click="zoomBy(-0.1)">−</button>
      <span class="zoom">{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="chip is-square" title="放大（Ctrl+滚轮）" @click="zoomBy(0.1)">+</button>
      <button type="button" class="chip" title="把整张图放进画布" @click="fitToWindow">适应窗口</button>
    </div>

    <div
      ref="canvas"
      class="canvas"
      :class="{ 'is-panning': panning, 'is-linking': linking !== null }"
      tabindex="0"
      role="application"
      aria-label="流程图画布"
      @keydown="onKey"
      @wheel.prevent="onWheel"
      @mousedown="startPan"
    >
      <div class="stage" :style="stageStyle">
        <svg class="edges" :width="size.width" :height="size.height">
          <defs>
            <marker id="fc-arrow" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0.6 L8 4 L0 7.4 z" fill="var(--text-2)" fill-opacity="0.62" />
            </marker>
            <marker id="fc-arrow-on" viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M0 0.6 L8 4 L0 7.4 z" fill="var(--accent)" />
            </marker>
          </defs>

          <g v-for="shape in edges" :key="shape.key">
            <!-- 宽一点的透明线做点击命中：1.6px 的线实在点不到 -->
            <path
              :d="shape.d"
              class="hit"
              @click.stop="selectEdge(shape)"
              @dblclick.stop="startEdgeEdit(shape)"
            />
            <path
              :d="shape.d"
              class="edge"
              :class="{ 'is-selected': shape.selected }"
              :marker-end="shape.edge.arrow ? (shape.selected ? 'url(#fc-arrow-on)' : 'url(#fc-arrow)') : undefined"
            />
            <text
              v-if="shape.edge.label && editingEdge !== shape.key"
              class="edge-label"
              :x="shape.label.x"
              :y="shape.label.y - 6"
              text-anchor="middle"
            >
              {{ shape.edge.label }}
            </text>
            <foreignObject
              v-if="editingEdge === shape.key"
              :x="shape.label.x - 46"
              :y="shape.label.y - 26"
              width="92"
              height="30"
            >
              <input
                :ref="setEdgeInputRef"
                v-model="edgeText"
                class="edge-input"
                type="text"
                placeholder="线上文字"
                @keydown="onEdgeKey"
                @blur="finishEdgeEdit"
              />
            </foreignObject>
          </g>

          <path v-if="rubber" :d="rubber.d" class="rubber" />
        </svg>

        <div
          v-for="box in boxes"
          :key="box.node.id"
          class="node"
          :class="[`is-${box.node.shape}`, { 'is-selected': box.selected, 'is-target': box.linkTarget }]"
          :data-node-id="box.node.id"
          :style="{ left: `${box.x}px`, top: `${box.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :title="box.node.text"
          @mousedown="startDrag(box.node, $event)"
          @dblclick.stop="startEdit(box.node)"
        >
          <input
            v-if="editingId === box.node.id"
            :ref="setInputRef"
            v-model="editText"
            class="edit"
            type="text"
            @mousedown.stop
            @keydown="onEditKey"
            @blur="finishEdit"
          />
          <span v-else class="text">{{ box.node.text || '（空）' }}</span>
          <!-- 右边缘那个小圆点：按住拖到另一个节点上就连一条线 -->
          <span
            class="port"
            title="按住拖到另一个节点上，连一条线"
            @mousedown="startLink(box.node, $event)"
            @dblclick.stop
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow {
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

.shape-pick {
  height: 28px;
  padding: 0 6px;
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
}

.shape-pick:disabled {
  opacity: 0.45;
}

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

.canvas {
  position: relative;
  flex: 1 1 auto;
  min-height: 300px;
  overflow: hidden;
  border-radius: var(--r-sm);
  background: var(--bg);
  border: 1px solid var(--surface-border);
  outline: none;
  cursor: grab;
  user-select: none;
}

.canvas.is-panning {
  cursor: grabbing;
}

.canvas.is-linking {
  cursor: crosshair;
}

.stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.edges {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
}

.edge {
  fill: none;
  stroke: var(--text-2);
  stroke-opacity: 0.62;
  stroke-width: 1.6;
  pointer-events: none;
}

.edge.is-selected {
  stroke: var(--accent);
  stroke-opacity: 1;
  stroke-width: 2;
}

.hit {
  fill: none;
  stroke: transparent;
  stroke-width: 14;
  cursor: pointer;
}

.rubber {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-dasharray: 5 4;
  pointer-events: none;
}

.edge-label {
  font-size: 11px;
  fill: var(--text-2);
  pointer-events: none;
}

.edge-input {
  width: 88px;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--r-xs);
  border: 1px solid var(--accent);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
}

.node {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-1);
  font-size: var(--fs-sm);
  cursor: grab;
  user-select: none;
}

/* 形状只改外形，不改尺寸 —— 尺寸一变，摆好的位置就全乱了 */
.node.is-round {
  border-radius: 999px;
}

.node.is-stadium {
  border-radius: 999px;
  border-left-width: 6px;
  border-right-width: 6px;
}

.node.is-diamond {
  border-radius: 4px;
  transform: rotate(0deg) scale(0.92);
}

.node.is-circle {
  border-radius: 50%;
}

.node.is-hex {
  /* 六边形的边是斜的，CSS 画不出来 —— 用 clip-path 裁一层底，边框才不会跟着被裁掉 */
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.node.is-hex::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  clip-path: polygon(16% 0, 84% 0, 100% 50%, 84% 100%, 16% 100%, 0 50%);
}

.node.is-hex.is-selected::before {
  border-color: var(--accent);
}

.node.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.node.is-target {
  border-style: dashed;
  border-color: var(--accent);
}

.text {
  position: relative;
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

/* 连线起点：默认只露一点，指到节点上才明显 —— 一直画着会让人以为节点上有个按钮 */
.port {
  position: absolute;
  right: -7px;
  top: 50%;
  width: 11px;
  height: 11px;
  margin-top: -5.5px;
  border-radius: 50%;
  background: var(--surface);
  border: 1.5px solid var(--accent);
  opacity: 0.35;
  cursor: crosshair;
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.node:hover .port,
.node.is-selected .port {
  opacity: 1;
}
</style>
