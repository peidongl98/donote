<script setup lang="ts">
/**
 * 「移到…」的文件夹选择框。列表页的笔记菜单、侧栏树里的笔记 / 文件夹菜单共用同一个。
 *
 * 只做「列出来 + 报出用户点了哪个」，真正的移动由调用方发（笔记走 `notesApi.update`
 * 改 folder_id，文件夹走 `foldersApi.move`）—— 两种移动的数据层入口不同，不该塞进这里。
 *
 * 不能选的目标不摆出来（`pickableFolders`）：自己和自己的子树。数据层另有同样的拒绝逻辑。
 */
import { ref, watch } from 'vue';
import type { FolderDTO } from '@donote/shared';
import { foldersApi } from '@/storage/notes';
import { pickableFolders } from '@/utils/folder-tree';
import AppDialog from '@/components/AppDialog.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    /** 不能作为目标的条目（文件夹移动时传自己） */
    excludeIds?: string[];
    busy?: boolean;
  }>(),
  { title: '移动到', excludeIds: () => [], busy: false },
);

const emit = defineEmits<{ close: []; pick: [string | null] }>();

const folders = ref<FolderDTO[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    // 拉不到就只留「未归类」，不阻塞移动
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

const rows = () => pickableFolders(folders.value, props.excludeIds);
</script>

<template>
  <AppDialog
    :open="open"
    :title="title"
    confirm-label="关闭"
    :busy="busy"
    @close="emit('close')"
    @confirm="emit('close')"
  >
    <div class="folder-list">
      <button type="button" class="folder-pick" @click="emit('pick', null)">未归类</button>
      <button v-for="row in rows()" :key="row.folder.id" type="button" class="folder-pick" @click="emit('pick', row.folder.id)">
        <span class="indent" :style="{ paddingLeft: `${row.depth * 14}px` }">📁 {{ row.folder.name }}</span>
      </button>
      <p v-if="loading" class="hint">加载中…</p>
    </div>
  </AppDialog>
</template>

<style scoped>
.indent {
  display: block;
}

.hint {
  font-size: 12px;
  color: var(--text-2);
}
</style>
