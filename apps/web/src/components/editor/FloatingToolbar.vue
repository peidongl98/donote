<script setup lang="ts">
/**
 * 选中文字时浮出来的小工具条。
 *
 * 只放最常用的五个行内操作：加粗 / 斜体 / 删除线 / 行内代码 / 清除格式。
 * 位置由父组件按选区算好传进来（position: fixed，相对视口）。
 * 所有按钮都 mousedown.prevent —— 一旦让鼠标按下夺走焦点，选区就没了，命令会打空。
 */
import type { Editor } from '@milkdown/kit/core';
import {
  clearFormat,
  toggleEmphasis,
  toggleInlineCode,
  toggleStrike,
  toggleStrong,
  type ToolbarSnapshot,
} from './commands';

defineProps<{
  editor: Editor | null;
  state: ToolbarSnapshot;
  x: number;
  y: number;
}>();

const TOOLS = [
  { id: 'bold', label: '加粗', active: 'strong', paths: ['M8.5 5.5h5a3.25 3.25 0 0 1 0 6.5h-5z', 'M8.5 12h5.8a3.25 3.25 0 0 1 0 6.5H8.5z'] },
  { id: 'italic', label: '斜体', active: 'emphasis', paths: ['M14.5 5.5h-4M13.5 18.5h-4M13.8 5.5l-3.6 13'] },
  {
    id: 'strike',
    label: '删除线',
    active: 'strikethrough',
    paths: ['M5.5 12h13', 'M8.6 8.3A3.6 3.6 0 0 1 12 6c2 0 3.5 1 3.9 2.5', 'M15.4 15.7c-.4 1.5-1.9 2.3-3.9 2.3s-3.6-1-3.9-2.5'],
  },
  { id: 'code', label: '行内代码', active: 'inlineCode', paths: ['M9.5 8 5.5 12l4 4', 'M14.5 8l4 4-4 4'] },
] as const;

function onTool(id: string, editor: Editor | null): void {
  switch (id) {
    case 'bold':
      toggleStrong(editor);
      break;
    case 'italic':
      toggleEmphasis(editor);
      break;
    case 'strike':
      toggleStrike(editor);
      break;
    case 'code':
      toggleInlineCode(editor);
      break;
    default:
      break;
  }
}
</script>

<template>
  <div
    class="float-bar glass"
    :style="{ left: `${x}px`, top: `${y}px` }"
    role="toolbar"
    aria-label="选中文字的操作"
  >
    <button
      v-for="tool in TOOLS"
      :key="tool.id"
      type="button"
      class="tool"
      :class="{ 'is-on': state[tool.active] }"
      :aria-label="tool.label"
      :title="tool.label"
      @mousedown.prevent
      @click="onTool(tool.id, editor)"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          v-for="(d, i) in tool.paths"
          :key="i"
          :d="d"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <span class="divider" aria-hidden="true" />

    <button
      type="button"
      class="tool"
      aria-label="清除格式"
      title="清除格式"
      @mousedown.prevent
      @click="clearFormat(editor)"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M7 7h7M10.5 7 8.5 17M12 17h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        <path d="m15.5 13.5 4 4M19.5 13.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.float-bar {
  position: fixed;
  z-index: 16;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: var(--r-sm);
  transform: translate(-50%, -100%);
  animation: float-in var(--dur-fast) var(--ease-spring) both;
}

@keyframes float-in {
  from {
    opacity: 0;
    transform: translate(-50%, -92%);
  }
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.tool:hover {
  background: var(--accent-soft);
  color: var(--text);
}

.tool.is-on {
  background: var(--accent);
  color: var(--on-accent);
}

.divider {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--divider);
}
</style>
