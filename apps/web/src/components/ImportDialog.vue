<script setup lang="ts">
/**
 * 「导入什么？」的二选一框。侧栏的导入按钮、笔记列表页顶栏的导入按钮、侧栏菜单的
 * 「在此导入 / 导入…」都开它 —— 一处实现，三处入口走同一套规则。
 *
 * 为什么要问一句：Windows 的系统文件对话框**一次只能选文件或只能选文件夹**，
 * 硬凑成一个动作做不到。两边的后半段完全一样，都是 `services/import-pick`。
 */
import { ref } from 'vue';
import { importFiles, importFolder } from '@/services/import-pick';
import AppDialog from '@/components/AppDialog.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 导入到哪个文件夹；null = 根目录 */
    folderId?: string | null;
  }>(),
  { folderId: null },
);

const emit = defineEmits<{ close: []; done: [] }>();

const busy = ref(false);

async function pick(kind: 'files' | 'folder'): Promise<void> {
  if (busy.value) return;
  emit('close');
  busy.value = true;
  try {
    const result =
      kind === 'files' ? await importFiles(props.folderId) : await importFolder(props.folderId);
    if (result) emit('done');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    title="导入什么？"
    confirm-label="取消"
    :busy="busy"
    @close="emit('close')"
    @confirm="emit('close')"
  >
    <div class="choices">
      <button type="button" class="choice" :disabled="busy" @click="pick('files')">
        <strong>Markdown 文件</strong>
        <span>可多选，每个 .md 成为一篇笔记；重名自动加后缀</span>
      </button>
      <button type="button" class="choice" :disabled="busy" @click="pick('folder')">
        <strong>文件夹</strong>
        <span>递归导入里面的 .md，子目录结构照原样建出来</span>
      </button>
    </div>
  </AppDialog>
</template>

<style scoped>
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px var(--sp-2);
  border-radius: var(--r-md);
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition:
    border-color var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth);
}

.choice:hover:not(:disabled) {
  border-color: var(--accent-ring);
}

.choice:disabled {
  opacity: 0.5;
}

.choice strong {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.choice span {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
</style>
