<script setup lang="ts">
/**
 * Word 式工具栏。
 *
 * 只负责「长什么样、点了发什么」，不碰文档：所有改动都回去调 commands.ts，
 * 这样工具栏可以随便换皮，编辑逻辑只有一份。
 *
 * 分两组：段落样式下拉（正文 / 标题 1–6），行内与块级操作按钮。
 * 光标在表格里时，下面多出一行表格操作。
 */
import { computed, ref } from 'vue';
import type { Editor } from '@milkdown/kit/core';
import { useUiStore } from '@/stores/ui';
import {
  addColAfter,
  addRowAfter,
  alignColumn,
  applyLink,
  clearFormat,
  dropTable,
  insertHr,
  insertMermaid,
  insertTable,
  removeCol,
  removeLink,
  removeRow,
  selectColAt,
  selectRowAt,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleCodeBlock,
  toggleEmphasis,
  toggleInlineCode,
  toggleOrderedList,
  toggleStrike,
  toggleStrong,
  toggleTaskList,
  type ToolbarSnapshot,
} from './commands';

const props = defineProps<{
  editor: Editor | null;
  state: ToolbarSnapshot;
  /** 只读时整条工具栏不响应 */
  disabled?: boolean;
}>();

const emit = defineEmits<{ image: [] }>();

const ui = useUiStore();

/** 图标用一条或多条 stroke 路径描述；fill 一律 none，靠 currentColor 上色 */
interface Tool {
  id: string;
  label: string;
  paths: string[];
  /** 与快照里的哪个字段联动高亮 */
  active?: keyof ToolbarSnapshot;
  dot?: boolean;
  /** 预设里真实存在的快捷键，只用来写 tooltip（不存在就不写，免得教人按没用的键） */
  key?: string;
}

const INLINE_TOOLS: Tool[] = [
  {
    id: 'bold',
    label: '加粗',
    key: 'Ctrl+B',
    active: 'strong',
    paths: ['M8.5 5.5h5a3.25 3.25 0 0 1 0 6.5h-5z', 'M8.5 12h5.8a3.25 3.25 0 0 1 0 6.5H8.5z'],
  },
  {
    id: 'italic',
    label: '斜体',
    key: 'Ctrl+I',
    active: 'emphasis',
    paths: ['M14.5 5.5h-4M13.5 18.5h-4M13.8 5.5l-3.6 13'],
  },
  {
    id: 'strike',
    label: '删除线',
    key: 'Ctrl+Alt+X',
    active: 'strikethrough',
    paths: ['M5.5 12h13', 'M8.6 8.3A3.6 3.6 0 0 1 12 6c2 0 3.5 1 3.9 2.5', 'M15.4 15.7c-.4 1.5-1.9 2.3-3.9 2.3s-3.6-1-3.9-2.5'],
  },
  {
    id: 'code',
    label: '行内代码',
    key: 'Ctrl+E',
    active: 'inlineCode',
    paths: ['M9.5 8 5.5 12l4 4', 'M14.5 8l4 4-4 4'],
  },
];

const BLOCK_TOOLS: Tool[] = [
  {
    id: 'bullet',
    label: '无序列表',
    key: 'Ctrl+Alt+8',
    active: 'bulletList',
    paths: ['M9 7h11M9 12h11M9 17h11', 'M4.6 6.8 5.4 7.6 7 5.8', 'M4.6 11.8 5.4 12.6 7 10.8', 'M4.6 16.8 5.4 17.6 7 15.8'],
  },
  {
    id: 'ordered',
    label: '有序列表',
    key: 'Ctrl+Alt+7',
    active: 'orderedList',
    paths: ['M10 7h10M10 12h10M10 17h10', 'M4 5.5h1v4', 'M3.4 14.9c.3-.5 1-.6 1.4-.2.4.4.3 1-.2 1.3l-1.4 1H6'],
  },
  {
    id: 'task',
    label: '任务清单',
    active: 'taskList',
    paths: ['M4 7.5h3.2v3.2H4z', 'M5 9 5.9 10l1.6-1.8', 'M4 15.5h3.2v3.2H4z', 'M11 9h9M11 17h9'],
  },
  {
    id: 'quote',
    label: '引用',
    key: 'Ctrl+Shift+B',
    active: 'blockquote',
    paths: ['M6.5 8.5h2.6v4.2c0 1.9-1 3-2.6 3.3', 'M14.5 8.5h2.6v4.2c0 1.9-1 3-2.6 3.3'],
  },
  {
    id: 'block',
    label: '代码块',
    key: 'Ctrl+Alt+C',
    active: 'codeBlock',
    paths: ['M4.5 5.5h15v13h-15z', 'M10.5 9.5 8.5 12l2 2.5', 'M13.5 9.5l2 2.5-2 2.5'],
  },
  {
    id: 'table',
    label: '表格',
    active: 'inTable',
    paths: ['M4.5 6h15v12h-15z', 'M4.5 10.5h15', 'M10.5 6v12'],
  },
  {
    id: 'link',
    label: '链接',
    paths: ['M10.6 13.4a3.6 3.6 0 0 1 0-5.1l1.9-1.9a3.6 3.6 0 0 1 5.1 5.1l-.9.9', 'M13.4 10.6a3.6 3.6 0 0 1 0 5.1l-1.9 1.9a3.6 3.6 0 0 1-5.1-5.1l.9-.9'],
  },
  {
    id: 'image',
    label: '图片',
    paths: ['M4.5 6h15v12h-15z', 'M8.6 10.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8', 'm5 16.5 4.2-4.6 3.6 3.6 2.4-2.4 3.8 3.4'],
  },
  {
    id: 'hr',
    label: '分割线',
    paths: ['M5 12h14'],
  },
  {
    id: 'mindmap',
    label: '思维导图',
    active: 'mermaid',
    paths: ['M3.8 12h5', 'M8.8 5.5v13', 'M8.8 5.5h4M8.8 12h4M8.8 18.5h4', 'M14.8 3.5h5v4h-5zM14.8 10h5v4h-5zM14.8 16.5h5v4h-5z'],
  },
];

const HEADINGS = [
  { value: 0, label: '正文' },
  { value: 1, label: '标题 1' },
  { value: 2, label: '标题 2' },
  { value: 3, label: '标题 3' },
  { value: 4, label: '标题 4' },
  { value: 5, label: '标题 5' },
  { value: 6, label: '标题 6' },
];

const linkOpen = ref(false);
const linkValue = ref('');

/** 表格尺寸网格：点「表格」弹 8×8，悬停选尺寸，点了才插；初始高亮 3×3 */
const GRID_MAX = 8;
const tableOpen = computed(() => props.state.inTable);
const gridOpen = ref(false);
const gridSize = ref({ row: 3, col: 3 });
const currentHeading = computed(() => props.state.heading);

function openGrid(): void {
  gridSize.value = { row: 3, col: 3 };
  gridOpen.value = true;
}

function confirmGrid(): void {
  insertTable(props.editor, gridSize.value.row, gridSize.value.col);
  gridOpen.value = false;
}

function isOn(tool: Tool): boolean {
  if (!tool.active) return false;
  const value = props.state[tool.active];
  return typeof value === 'boolean' ? value : false;
}

/** tooltip：有快捷键就写成「加粗 (Ctrl+B)」，没有就只写名字 */
function hint(tool: Tool): string {
  return tool.key ? `${tool.label} (${tool.key})` : tool.label;
}

function onHeading(event: Event): void {
  if (props.disabled) return;
  setHeading(props.editor, Number((event.target as HTMLSelectElement).value));
}

function onTool(tool: Tool): void {
  if (props.disabled) return;
  const e = props.editor;
  switch (tool.id) {
    case 'bold':
      toggleStrong(e);
      break;
    case 'italic':
      toggleEmphasis(e);
      break;
    case 'strike':
      toggleStrike(e);
      break;
    case 'code':
      toggleInlineCode(e);
      break;
    case 'bullet':
      toggleBulletList(e);
      break;
    case 'ordered':
      toggleOrderedList(e);
      break;
    case 'task':
      toggleTaskList(e);
      break;
    case 'quote':
      toggleBlockquote(e);
      break;
    case 'block':
      toggleCodeBlock(e, props.state.codeBlock);
      break;
    case 'table':
      // 已经在表格里就不再插一张（每点一次多一张表，见 docs/editor-audit.md P1-5）；
      // 行列操作走下面那行表格按钮
      if (!props.state.inTable) openGrid();
      break;
    case 'link':
      linkValue.value = props.state.link ?? '';
      linkOpen.value = true;
      break;
    case 'image':
      emit('image');
      break;
    case 'hr':
      insertHr(e);
      break;
    case 'mindmap':
      insertMermaid(e);
      break;
    default:
      break;
  }
}

function confirmLink(): void {
  applyLink(props.editor, linkValue.value.trim());
  linkOpen.value = false;
}

/**
 * 删行 / 删列。
 *
 * 删不掉的时候必须说一句话 —— 按钮点了什么也没发生，用户只会以为是坏的
 * （gfm 的表必须有表头行，正文行 / 列也至少各留一个，这三种就是删不掉的情况）。
 */
function removeAxis(kind: 'row' | 'col'): void {
  if (props.disabled) return;
  const result = kind === 'row' ? removeRow(props.editor) : removeCol(props.editor);
  if (result === 'ok' || result === 'none') return;
  ui.toast(
    result === 'header'
      ? '表头行不能删除，表格必须有一行表头'
      : kind === 'row'
        ? '至少保留一行内容行'
        : '至少保留一列',
  );
}

function dropLink(): void {
  removeLink(props.editor);
  linkOpen.value = false;
}
</script>

<template>
  <div class="toolbar" :class="{ 'is-disabled': disabled }">
    <div class="row">
      <label class="picker">
        <select :value="currentHeading" :disabled="disabled" aria-label="段落样式" @change="onHeading">
          <option v-for="h in HEADINGS" :key="h.value" :value="h.value">{{ h.label }}</option>
        </select>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </label>

      <span class="divider" aria-hidden="true" />

      <button
        v-for="tool in INLINE_TOOLS"
        :key="tool.id"
        type="button"
        class="tool"
        :class="{ 'is-on': isOn(tool) }"
        :aria-label="tool.label"
        :title="hint(tool)"
        :aria-pressed="isOn(tool)"
        :disabled="disabled"
        @mousedown.prevent
        @click="onTool(tool)"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            v-for="(d, i) in tool.paths"
            :key="i"
            :d="d"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <span class="divider" aria-hidden="true" />

      <button
        v-for="tool in BLOCK_TOOLS"
        :key="tool.id"
        type="button"
        class="tool"
        :class="{ 'is-on': isOn(tool) }"
        :aria-label="tool.label"
        :title="hint(tool)"
        :aria-pressed="isOn(tool)"
        :disabled="disabled"
        @mousedown.prevent
        @click="onTool(tool)"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            v-for="(d, i) in tool.paths"
            :key="i"
            :d="d"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <!-- 光标在表格里时多出一行表格操作 -->
    <div v-if="tableOpen && !disabled" class="row is-table">
      <span class="table-label">表格</span>
      <button type="button" class="chip" @mousedown.prevent @click="addRowAfter(editor)">下方加行</button>
      <button type="button" class="chip" @mousedown.prevent @click="addColAfter(editor)">右侧加列</button>
      <button type="button" class="chip" @mousedown.prevent @click="removeAxis('row')">删除本行</button>
      <button type="button" class="chip" @mousedown.prevent @click="removeAxis('col')">删除本列</button>
      <button type="button" class="chip is-danger" @mousedown.prevent @click="dropTable(editor)">删除表格</button>

      <span class="divider" aria-hidden="true" />

      <button type="button" class="chip" title="整列左对齐" @mousedown.prevent @click="alignColumn(editor, 'left')">
        左对齐
      </button>
      <button type="button" class="chip" title="整列居中" @mousedown.prevent @click="alignColumn(editor, 'center')">
        居中
      </button>
      <button type="button" class="chip" title="整列右对齐" @mousedown.prevent @click="alignColumn(editor, 'right')">
        右对齐
      </button>
      <button type="button" class="chip" title="选中光标所在的整行" @mousedown.prevent @click="selectRowAt(editor)">
        选中整行
      </button>
      <button type="button" class="chip" title="选中光标所在的整列" @mousedown.prevent @click="selectColAt(editor)">
        选中整列
      </button>
    </div>

    <!-- 表格尺寸网格：悬停预览行列数，点了插入（默认 3×3） -->
    <div v-if="gridOpen" class="popover is-grid">
      <p class="grid-hint">{{ gridSize.row }} × {{ gridSize.col }}</p>
      <div class="grid" @mouseleave="gridSize = { row: 3, col: 3 }">
        <button
          v-for="n in GRID_MAX * GRID_MAX"
          :key="n"
          type="button"
          class="grid-cell"
          :class="{ 'is-on': Math.ceil(n / GRID_MAX) <= gridSize.row && ((n - 1) % GRID_MAX) + 1 <= gridSize.col }"
          :aria-label="`${Math.ceil(n / GRID_MAX)} 行 ${((n - 1) % GRID_MAX) + 1} 列`"
          @mousedown.prevent
          @mouseenter="gridSize = { row: Math.ceil(n / GRID_MAX), col: ((n - 1) % GRID_MAX) + 1 }"
          @click="confirmGrid"
        />
      </div>
      <p class="grid-tip">悬停选行列数，点了插入</p>
    </div>

    <!-- 链接：选中文字后填地址 -->
    <div v-if="linkOpen" class="popover">
      <input
        v-model="linkValue"
        class="pop-input"
        type="url"
        placeholder="https://example.com"
        aria-label="链接地址"
        @keydown.enter.prevent="confirmLink"
        @keydown.esc.prevent="linkOpen = false"
      />
      <button type="button" class="chip is-primary" @click="confirmLink">确定</button>
      <button v-if="state.link" type="button" class="chip" @click="dropLink">移除</button>
      <button type="button" class="chip" @click="linkOpen = false">取消</button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
  padding: 6px;
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-1);
}

.row {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.row.is-table {
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--divider);
}

.table-label {
  font-size: var(--fs-xs);
  color: var(--text-2);
  margin-right: 2px;
}

.divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--divider);
  flex: none;
}

.picker {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
}

.picker select {
  appearance: none;
  height: 30px;
  padding: 0 26px 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  color: var(--text);
  background: transparent;
  cursor: pointer;
}

.picker select:hover {
  background: var(--accent-soft);
}

.picker svg {
  position: absolute;
  right: 8px;
  color: var(--text-2);
  pointer-events: none;
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  flex: none;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.tool:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--text);
}

.tool.is-on {
  background: var(--accent-soft);
  color: var(--accent);
}

.tool:disabled {
  opacity: 0.4;
  cursor: default;
}

.chip {
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.chip:hover {
  background: var(--accent-soft);
}

.chip.is-primary {
  color: var(--on-accent);
  background: var(--accent);
  border-color: transparent;
}

.chip.is-danger {
  color: var(--danger);
}

.popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 6px;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-3);
}

.pop-input {
  width: min(320px, 46vw);
  height: 30px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--surface-border);
}

.pop-input:focus {
  border-color: var(--accent-ring);
}

/* 表格尺寸网格 */
.popover.is-grid {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.grid-hint {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.grid {
  display: grid;
  grid-template-columns: repeat(8, 16px);
  gap: 2px;
}

.grid-cell {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
}

.grid-cell.is-on {
  background: var(--accent-soft);
  border-color: var(--accent-ring);
}

.grid-tip {
  font-size: var(--fs-xs);
  color: var(--text-2);
  opacity: 0.75;
}
</style>
