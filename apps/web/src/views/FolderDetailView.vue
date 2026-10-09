<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { NoteSummaryDTO } from '@donote/shared';
import { foldersApi, notesApi } from '@/storage/notes';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import NoteCard from '@/components/NoteCard.vue';
import EmptyState from '@/components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();

const folderId = String(route.params.id);
const folderName = ref('文件夹');
const notes = ref<NoteSummaryDTO[]>([]);
const loading = ref(true);

const subtitle = computed(() => `${notes.value.length} 篇笔记`);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [folders, list] = await Promise.all([
      foldersApi.list(),
      notesApi.list({ folder_id: folderId }),
    ]);
    const folder = folders.items.find((f) => f.id === folderId);
    if (!folder) {
      ui.toast('文件夹不存在');
      await router.replace('/folders');
      return;
    }
    folderName.value = folder.name;
    notes.value = list.items;
  } catch {
    ui.toast('加载失败');
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  try {
    const res = await notesApi.create({ title: '', content: '', folder_id: folderId });
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="page page-full">
    <AppHeader :title="folderName" :subtitle="subtitle" back back-to="/folders">
      <template #actions>
        <button class="add" type="button" aria-label="在此文件夹新建笔记" @click="create">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </template>
    </AppHeader>

    <div class="page-body">
      <EmptyState v-if="loading" loading title="加载中" />
      <EmptyState v-else-if="!notes.length" title="这个文件夹还是空的" hint="点右上角加号，直接在这里写笔记">
        <template #icon>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path
              d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2.5h6A2.5 2.5 0 0 1 20 10v6.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </template>
      </EmptyState>
      <div v-else class="stack">
        <NoteCard v-for="note in notes" :key="note.id" :note="note" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--r-pill);
  color: var(--accent);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.add:hover {
  background: var(--accent-soft);
}
</style>
