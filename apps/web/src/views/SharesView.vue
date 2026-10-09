<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { shareUrl, sharesApi, type ShareListItem } from '@/api/resources';
import { useUiStore } from '@/stores/ui';
import { formatTime } from '@/utils/format';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import EmptyState from '@/components/EmptyState.vue';

const items = ref<ShareListItem[]>([]);
const loading = ref(true);
const ui = useUiStore();

const revokeOpen = ref(false);
const revokeTarget = ref<ShareListItem | null>(null);
const busy = ref(false);

const activeCount = computed(
  () => items.value.filter((s) => !s.expired && !s.note_deleted).length,
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = (await sharesApi.list()).items;
  } catch {
    ui.toast('分享列表加载失败');
  } finally {
    loading.value = false;
  }
}

function stateOf(item: ShareListItem): { text: string; tone: 'ok' | 'warn' | 'dead' } {
  if (item.note_deleted) return { text: '笔记已删除 · 访客看到 410', tone: 'dead' };
  if (item.expired) return { text: '已过期 · 访客看到 410', tone: 'dead' };
  if (item.has_password) return { text: '需要密码', tone: 'warn' };
  return { text: '公开可访问', tone: 'ok' };
}

async function copy(item: ShareListItem): Promise<void> {
  const url = shareUrl(item.slug);
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('链接已复制');
  } catch {
    ui.toast(url);
  }
}

async function revoke(): Promise<void> {
  const target = revokeTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await sharesApi.remove(target.id);
    ui.toast('已撤销分享');
    revokeOpen.value = false;
    await load();
  } catch {
    ui.toast('撤销失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page page-full">
    <AppHeader
      title="分享管理"
      :subtitle="items.length ? `${activeCount} 条生效中 / 共 ${items.length} 条` : '分享出去的链接都在这里'"
      back
      back-to="/settings"
    />

    <div class="page-body">
      <EmptyState v-if="loading" loading title="加载中" />

      <EmptyState
        v-else-if="!items.length"
        title="还没有分享"
        hint="打开任意笔记，右上角菜单里选择「分享」即可生成链接"
      >
        <template #icon>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path
              d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"
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
        <div v-for="item in items" :key="item.id" class="share-card card-plain">
          <div class="head">
            <RouterLink class="note-title" :to="`/notes/${item.note_id}`">
              {{ item.note_title }}
            </RouterLink>
            <span class="views mono">{{ item.view_count }} 次</span>
          </div>

          <p class="state" :class="`is-${stateOf(item).tone}`">{{ stateOf(item).text }}</p>
          <p class="meta mono">{{ item.slug }} · {{ formatTime(item.created_at) }}</p>

          <div class="actions">
            <button type="button" class="btn-ghost small" @click="copy(item)">复制链接</button>
            <a class="btn-ghost small" :href="`/s/${item.slug}`" target="_blank" rel="noopener">打开</a>
            <button
              type="button"
              class="btn-ghost small is-danger"
              @click="revokeTarget = item; revokeOpen = true"
            >
              撤销
            </button>
          </div>
        </div>
      </div>
    </div>

    <AppDialog
      :open="revokeOpen"
      title="撤销这条分享？"
      confirm-label="撤销"
      danger
      :busy="busy"
      @close="revokeOpen = false"
      @confirm="revoke"
    >
      <p class="tip">撤销后这条链接立即失效（访客看到 404），但笔记本身不受影响。</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.share-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
}

.note-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.views {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

.state {
  font-size: 12px;
}

.state.is-ok {
  color: var(--accent);
}

.state.is-warn {
  color: var(--text-2);
}

.state.is-dead {
  color: var(--danger);
}

.meta {
  font-size: 11px;
  color: var(--text-2);
  word-break: break-all;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
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
