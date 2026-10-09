<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { FolderDTO, NoteSummaryDTO } from '@donote/shared';
import { foldersApi, hydrateExcerpts, notesApi } from '@/storage/notes';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import NoteCard from '@/components/NoteCard.vue';
import EmptyState from '@/components/EmptyState.vue';

const notes = ref<NoteSummaryDTO[]>([]);
const folders = ref<FolderDTO[]>([]);
const loading = ref(true);
const keyword = ref('');
const total = ref(0);

const router = useRouter();
const ui = useUiStore();

const subtitle = computed(() =>
  total.value ? `${total.value} 篇笔记` : '在这里写下第一条笔记',
);
const folderNames = computed<Record<string, string>>(() =>
  Object.fromEntries(folders.value.map((f) => [f.id, f.name])),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await notesApi.list({ q: keyword.value.trim() || undefined });
    notes.value = res.items;
    total.value = res.total;
  } catch {
    ui.toast('笔记加载失败，请检查网络');
  } finally {
    loading.value = false;
  }
}

/** 摘要要先读过正文才有，补齐一轮；补到了就再刷一次列表 */
let hydrating = false;
async function hydrate(): Promise<void> {
  if (hydrating) return;
  hydrating = true;
  try {
    if ((await hydrateExcerpts()) > 0) await load();
  } catch {
    // 摘要补齐失败不打扰用户，列表本身已经可用
  } finally {
    hydrating = false;
  }
}

async function loadFolders(): Promise<void> {
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    // 文件夹拉取失败不影响笔记列表展示
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(keyword, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 300);
});

async function create(): Promise<void> {
  try {
    const res = await notesApi.create({ title: '', content: '' });
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败，请稍后重试');
  }
}

onMounted(() => {
  loadFolders();
  load().then(hydrate);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <div class="page">
    <AppHeader title="DoNote" :subtitle="subtitle" />

    <div class="page-body">
      <div class="search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <input v-model="keyword" type="search" placeholder="搜索标题或正文" aria-label="搜索笔记" />
      </div>

      <div class="list-wrap">
        <EmptyState v-if="loading" loading title="加载中" />

        <EmptyState
          v-else-if="!notes.length"
          :title="keyword ? '没有匹配的笔记' : '还没有笔记'"
          :hint="keyword ? '换个关键词试试' : '随时记录，自动保存'"
        >
          <template #icon>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path
                d="M6 3.75h9.5a2.75 2.75 0 0 1 2.75 2.75v13.75H8.75A2.75 2.75 0 0 1 6 17.5V3.75Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path d="M9.5 9h5M9.5 12.5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </template>
          <button v-if="!keyword" class="btn-major" type="button" @click="create">写第一条笔记</button>
        </EmptyState>

        <div v-else class="stack">
          <NoteCard
            v-for="(note, index) in notes"
            :key="note.id"
            :note="note"
            :folder-name="note.folder_id ? folderNames[note.folder_id] : null"
            :style="{ animationDelay: `${Math.min(index, 8) * 45}ms` }"
            class="pop"
          />
        </div>
      </div>
    </div>

    <button class="fab" type="button" aria-label="新建笔记" @click="create">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.list-wrap {
  margin-top: var(--sp-2);
}

/* 列表项错位淡入 */
.pop {
  animation: pop-in var(--dur-slow) var(--ease-smooth) both;
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.fab {
  position: fixed;
  right: max(var(--sp-2), calc(50vw - 360px + var(--sp-2)));
  bottom: calc(84px + env(safe-area-inset-bottom, 0px));
  z-index: 7;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: var(--shadow-card);
  transition:
    transform var(--dur) var(--ease-spring),
    box-shadow var(--dur) var(--ease-smooth);
}

.fab:hover {
  transform: translateY(-2px);
}

.fab:active {
  transform: scale(0.94);
}
</style>
