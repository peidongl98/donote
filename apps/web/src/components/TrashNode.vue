<script setup lang="ts">
/**
 * 回收站树里的一个节点：顶层条目（`.row-card`）或它下面的子项（缩进行）。
 *
 * 两种行的差别只有「有没有删除时间 / 点标题是打开还是展开」，所以合成一个组件递归渲染 ——
 * 顶层条目里可能套着文件夹、文件夹里还有笔记，层数不固定。
 *
 * ⚠️ 子树是**兄弟节点**、不套在 `.row-card` 里面：套进去的话父卡片的文本会包含所有子孙，
 * 列表页 / 回归脚本「按标题找那一行」就会一次命中一大片。
 */
import { computed, ref } from 'vue';
import type { TrashChild, TrashEntry } from '@/storage/notes';
import { formatTime } from '@/utils/format';

const props = defineProps<{
  node: TrashEntry | TrashChild;
  /** 所属的顶层条目（顶层节点时与 node 是同一个） */
  entry: TrashEntry;
  top: boolean;
  depth: number;
  busy?: boolean;
}>();

const emit = defineEmits<{
  restore: [node: TrashEntry | TrashChild, entry: TrashEntry, top: boolean];
  purge: [node: TrashEntry | TrashChild, entry: TrashEntry, top: boolean];
  open: [entry: TrashEntry];
  menu: [entry: TrashEntry];
}>();

/** 顶层默认展开（一眼能看清这一条删了什么）；子层收起，避免深树一进来就铺满屏 */
const open = ref(props.top);

const kids = computed(() => props.node.children);
const deletedAt = computed(() => (props.top ? (props.node as TrashEntry).deletedAt : 0));
</script>

<template>
  <div class="node">
    <!-- 顶层条目：保持 .row-card 老样子 -->
    <div
      v-if="top"
      class="row-card card-plain"
      :class="{ 'is-folder': node.kind === 'folder' }"
      @contextmenu.prevent="emit('menu', entry)"
    >
      <button
        v-if="kids.length"
        type="button"
        class="twist"
        :aria-expanded="open"
        :aria-label="open ? '折叠' : '展开'"
        @click="open = !open"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="m9 6 6 6-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <span v-else class="twist" aria-hidden="true" />

      <button type="button" class="main" @click="node.kind === 'note' ? emit('open', entry) : (open = !open)">
        <span class="title">{{ node.kind === 'folder' ? `📁 ${node.title}` : node.title }}</span>
        <span class="time">删除于 {{ formatTime(deletedAt) }}</span>
      </button>

      <div class="ops">
        <button
          type="button"
          class="btn-ghost small"
          :disabled="busy"
          @click="emit('restore', node, entry, true)"
        >
          恢复
        </button>
        <button
          type="button"
          class="btn-ghost small is-danger"
          :disabled="busy"
          @click="emit('purge', node, entry, true)"
        >
          彻底删除
        </button>
      </div>
    </div>

    <!-- 子项：缩进一行，同样两项操作 -->
    <div v-else class="sub-row">
      <button
        v-if="kids.length"
        type="button"
        class="twist"
        :aria-expanded="open"
        :aria-label="open ? '折叠' : '展开'"
        @click="open = !open"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            d="m9 6 6 6-6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <span v-else class="twist" aria-hidden="true" />

      <span class="sub-title">
        {{ node.kind === 'folder' ? `📁 ${node.title}` : `📄 ${node.title}` }}
      </span>

      <div class="ops">
        <button
          type="button"
          class="btn-ghost small"
          :disabled="busy"
          @click="emit('restore', node, entry, false)"
        >
          恢复
        </button>
        <button
          type="button"
          class="btn-ghost small is-danger"
          :disabled="busy"
          @click="emit('purge', node, entry, false)"
        >
          彻底删除
        </button>
      </div>
    </div>

    <div v-if="open && kids.length" class="kids">
      <TrashNode
        v-for="child in kids"
        :key="child.rel"
        :node="child"
        :entry="entry"
        :top="false"
        :depth="depth + 1"
        :busy="busy"
        @restore="(n, e, t) => emit('restore', n, e, t)"
        @purge="(n, e, t) => emit('purge', n, e, t)"
      />
    </div>
  </div>
</template>

<style scoped>
.node {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

/* 顶层条目：与列表页的卡片同一套（.card-plain 是全局的） */
.row-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.row-card.is-folder {
  align-items: center;
}

.twist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 24px;
  flex: none;
  margin-top: 8px;
  color: var(--text-2);
  border-radius: var(--r-xs);
}

.row-card.is-folder .twist {
  margin-top: 0;
}

button.twist svg {
  transition: transform var(--dur-fast) var(--ease-smooth);
}

button.twist[aria-expanded='true'] svg {
  transform: rotate(90deg);
}

button.twist:hover {
  color: var(--text);
}

.main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  color: inherit;
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.time {
  font-size: 12px;
  color: var(--text-2);
}

.sub-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
}

.sub-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ops {
  display: flex;
  gap: 6px;
  flex: none;
  margin-top: 4px;
}

.sub-row .ops {
  margin-top: 0;
}

.btn-ghost.small {
  height: 34px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
}

.btn-ghost.small.is-danger {
  color: var(--danger);
}

/* 子树缩进 + 一条竖导线，层级一眼看出来 */
.kids {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid var(--surface-border);
}
</style>
