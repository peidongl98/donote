<script setup lang="ts">
import { computed } from 'vue';
import type { NoteSummaryDTO } from '@donote/shared';
import { cleanExcerpt, formatTime } from '@/utils/format';

const props = defineProps<{ note: NoteSummaryDTO; folderName?: string | null }>();

const excerpt = computed(() => cleanExcerpt(props.note.excerpt).slice(0, 90));
</script>

<template>
  <RouterLink class="card glass" :to="`/notes/${note.id}`">
    <div class="top">
      <h3 class="title">{{ note.title }}</h3>
      <time class="time">{{ formatTime(note.updated_at) }}</time>
    </div>
    <p v-if="excerpt" class="excerpt">{{ excerpt }}</p>
    <span v-if="folderName" class="folder">{{ folderName }}</span>
    <span v-if="note.deleted_at" class="deleted">已删除</span>
  </RouterLink>
</template>

<style scoped>
.card {
  display: block;
  padding: var(--sp-2);
  border-radius: var(--r-lg);
  text-decoration: none;
  color: inherit;
  transition:
    transform var(--dur) var(--ease-spring),
    box-shadow var(--dur) var(--ease-smooth);
}

.card:hover {
  transform: translateY(-2px);
}

.card:active {
  transform: scale(0.99);
}

.top {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
}

.title {
  flex: 1 1 auto;
  font-size: 16px;
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

.excerpt {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.folder,
.deleted {
  display: inline-block;
  margin-top: var(--sp-1);
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent);
}

.deleted {
  margin-left: 6px;
  background: var(--danger-soft);
  color: var(--danger);
}
</style>
