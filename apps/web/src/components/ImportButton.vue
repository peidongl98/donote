<script setup lang="ts">
/**
 * 导入按钮：侧栏顶部（「新建笔记」旁边）与笔记列表页顶栏共用。
 *
 * 点击后先问「导入什么」（`ImportDialog`），再走系统文件对话框 —— 两边的落盘规则
 * 与拖放完全一样（多个 .md 各成一篇、文件夹递归、重名加后缀），入口不同而已。
 */
import { ref } from 'vue';
import ImportDialog from '@/components/ImportDialog.vue';

const props = withDefaults(
  defineProps<{
    /** 导入到哪个文件夹；null = 根目录 */
    folderId?: string | null;
    /** 文案；compact 时只留图标，文字作为无障碍名 */
    label?: string;
    /** 侧栏空间紧，只留图标 */
    compact?: boolean;
  }>(),
  { folderId: null, label: '导入', compact: false },
);

const emit = defineEmits<{ done: [] }>();

const open = ref(false);
</script>

<template>
  <button
    class="import-btn"
    :class="{ 'is-compact': compact }"
    type="button"
    :aria-label="label"
    :title="label"
    @click="open = true"
  >
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
    <span v-if="!compact" class="txt">{{ label }}</span>
  </button>

  <ImportDialog
    :open="open"
    :folder-id="props.folderId"
    @close="open = false"
    @done="emit('done')"
  />
</template>

<style scoped>
.import-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  padding: 0 12px;
  border-radius: var(--r-sm);
  font-size: var(--fs-base);
  font-weight: 540;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    border-color var(--dur-fast) var(--ease-smooth);
}

.import-btn:hover {
  border-color: var(--accent-ring);
}

/* 侧栏版本：跟「新建笔记」等高、方一些，塞得进那一行 */
.import-btn.is-compact {
  width: 38px;
  padding: 0;
  flex: none;
}

.txt {
  white-space: nowrap;
}
</style>
