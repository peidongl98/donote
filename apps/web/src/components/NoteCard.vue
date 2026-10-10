<script setup lang="ts">
import { computed } from 'vue';
import type { NoteSummaryDTO } from '@donote/shared';
import { cleanExcerpt, formatTime } from '@/utils/format';

const props = defineProps<{ note: NoteSummaryDTO; folderName?: string | null }>();
const emit = defineEmits<{ menu: [note: NoteSummaryDTO] }>();

const excerpt = computed(() => cleanExcerpt(props.note.excerpt).slice(0, 90));
</script>

<template>
  <div class="card glass" @contextmenu.prevent="emit('menu', note)">
    <RouterLink class="main" :to="`/notes/${note.id}`">
      <div class="top">
        <h3 class="title">{{ note.title }}</h3>
        <time class="time">{{ formatTime(note.updated_at) }}</time>
      </div>
      <p v-if="excerpt" class="excerpt">{{ excerpt }}</p>
      <span v-if="folderName" class="folder">{{ folderName }}</span>
      <span v-if="note.deleted_at" class="deleted">已删除</span>
    </RouterLink>

    <button class="more" type="button" aria-label="更多操作" @click.prevent.stop="emit('menu', note)">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6" fill="currentColor" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        <circle cx="19" cy="12" r="1.6" fill="currentColor" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  border-radius: var(--r-lg);
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

.main {
  display: block;
  padding: var(--sp-2);
  text-decoration: none;
  color: inherit;
}

.top {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  /* 给右上角的「更多」让位，否则时间会被压住 */
  padding-right: 30px;
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

.more {
  position: absolute;
  top: 8px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-pill);
  color: var(--text-2);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth);
}

.card:hover .more,
.more:focus-visible {
  opacity: 1;
}

.more:hover {
  color: var(--text);
  background: var(--surface);
}

/* 触屏没有 hover，常显 */
@media (hover: none) {
  .more {
    opacity: 1;
  }
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
