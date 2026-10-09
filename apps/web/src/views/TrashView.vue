<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { NoteSummaryDTO } from '@donote/shared';
import { notesApi } from '@/api/resources';
import { useUiStore } from '@/stores/ui';
import { formatTime } from '@/utils/format';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import EmptyState from '@/components/EmptyState.vue';

const notes = ref<NoteSummaryDTO[]>([]);
const loading = ref(true);
const ui = useUiStore();
const router = useRouter();

const hardOpen = ref(false);
const hardTarget = ref<NoteSummaryDTO | null>(null);
const busy = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    notes.value = (await notesApi.list({ trash: true })).items;
  } catch {
    ui.toast('回收站加载失败');
  } finally {
    loading.value = false;
  }
}

async function restore(note: NoteSummaryDTO): Promise<void> {
  busy.value = true;
  try {
    await notesApi.restore(note.id);
    ui.toast('已恢复');
    await load();
  } catch {
    ui.toast('恢复失败');
  } finally {
    busy.value = false;
  }
}

async function hardDelete(): Promise<void> {
  const target = hardTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await notesApi.remove(target.id, true);
    ui.toast('已彻底删除');
    hardOpen.value = false;
    await load();
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page page-full">
    <AppHeader
      title="回收站"
      :subtitle="notes.length ? `${notes.length} 篇待处理` : '删除的笔记会先放到这里'"
      back
      back-to="/settings"
    />

    <div class="page-body">
      <EmptyState v-if="loading" loading title="加载中" />

      <EmptyState v-else-if="!notes.length" title="回收站是空的" hint="删除笔记后会先进入这里，随时可以恢复">
        <template #icon>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path
              d="M6 7.5h12M9.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v1.5M8 7.5l.6 10A1.5 1.5 0 0 0 10.1 19h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </template>
      </EmptyState>

      <div v-else class="stack">
        <div v-for="note in notes" :key="note.id" class="row-card card-plain">
          <button type="button" class="main" @click="router.push(`/notes/${note.id}`)">
            <span class="title">{{ note.title }}</span>
            <span class="time">删除于 {{ formatTime(note.deleted_at) }}</span>
          </button>
          <div class="ops">
            <button type="button" class="btn-ghost small" :disabled="busy" @click="restore(note)">
              恢复
            </button>
            <button
              type="button"
              class="btn-ghost small is-danger"
              @click="hardTarget = note; hardOpen = true"
            >
              彻底删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <AppDialog
      :open="hardOpen"
      title="彻底删除？"
      confirm-label="彻底删除"
      danger
      :busy="busy"
      @close="hardOpen = false"
      @confirm="hardDelete"
    >
      <p class="tip">「{{ hardTarget?.title }}」将被永久清除，连同它的分享记录，无法恢复。</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.row-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.main {
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

.ops {
  display: flex;
  gap: 6px;
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

.tip {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
</style>
