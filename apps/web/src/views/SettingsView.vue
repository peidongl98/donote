<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { NoteSummaryDTO } from '@donote/shared';
import { notesApi, sharesApi } from '@/api/resources';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { formatTime } from '@/utils/format';
import AppHeader from '@/components/AppHeader.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();

const shareCount = ref<number | null>(null);
const trashCount = ref<number | null>(null);
const signingOut = ref(false);

const displayName = computed(() => auth.user?.nickname || auth.user?.phone || '未登录');
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase() || 'D');
const joined = computed(() => formatTime(auth.user?.created_at ?? null));

onMounted(async () => {
  try {
    const [shares, trash] = await Promise.all([
      sharesApi.list(),
      notesApi.list({ trash: true, limit: 1 }),
    ]);
    shareCount.value = shares.items.length;
    trashCount.value = trash.total;
  } catch {
    // 统计失败不影响设置项本身
  }
});

async function onLogout(): Promise<void> {
  signingOut.value = true;
  await auth.logout();
  ui.toast('已退出登录');
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div class="page">
    <AppHeader title="设置" />

    <div class="page-body">
      <section class="card-plain profile">
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
        <div class="profile-main">
          <p class="name">{{ displayName }}</p>
          <p class="meta mono">
            {{ auth.tenant?.name ?? '个人空间' }} · {{ auth.tenant?.plan ?? 'free' }} 套餐
          </p>
          <p class="meta">加入于 {{ joined }}</p>
        </div>
      </section>

      <p class="section-title">内容</p>
      <button type="button" class="tile" @click="router.push('/shares')">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="tile-main">
          <span class="tile-name">分享管理</span>
          <span class="tile-sub">管理已生成的公开链接</span>
        </span>
        <span class="tile-tail mono">{{ shareCount ?? '—' }}</span>
      </button>

      <button type="button" class="tile" @click="router.push('/trash')">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M6 7.5h12M9.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v1.5M8 7.5l.6 10A1.5 1.5 0 0 0 10.1 19h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="tile-main">
          <span class="tile-name">回收站</span>
          <span class="tile-sub">恢复或彻底删除已删笔记</span>
        </span>
        <span class="tile-tail mono">{{ trashCount ?? '—' }}</span>
      </button>

      <p class="section-title">外观</p>
      <div class="tile as-row">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M12 4v16" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M12 20a8 8 0 0 0 0-16Z" fill="currentColor" />
          </svg>
        </span>
        <span class="tile-main">
          <span class="tile-name">主题</span>
          <span class="tile-sub">默认跟随系统，可手动覆盖</span>
        </span>
        <ThemeToggle />
      </div>

      <p class="section-title">账号</p>
      <div class="card-plain">
        <p class="line">
          <span class="line-key">手机号</span>
          <span class="line-val mono">{{ auth.user?.phone ?? '—' }}</span>
        </p>
        <p class="line">
          <span class="line-key">用户 ID</span>
          <span class="line-val mono">{{ auth.user?.id ?? '—' }}</span>
        </p>
      </div>

      <button class="logout" type="button" :disabled="signingOut" @click="onLogout">
        {{ signingOut ? '正在退出…' : '退出登录' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.profile {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 18px;
  font-weight: 650;
  flex: none;
}

.profile-main {
  min-width: 0;
}

.name {
  font-size: 17px;
  font-weight: 620;
}

.meta {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile {
  margin-bottom: var(--sp-1);
}

.tile.as-row {
  cursor: default;
}

.tile.as-row:hover {
  transform: none;
}

.tile-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}

.tile-tail {
  flex: none;
  font-size: 13px;
  color: var(--text-2);
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px 0;
}

.line + .line {
  border-top: 1px solid var(--divider);
}

.line-key {
  font-size: 13px;
  color: var(--text-2);
  flex: none;
}

.line-val {
  font-size: 13px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout {
  margin-top: var(--sp-4);
  width: 100%;
  height: 48px;
  border-radius: var(--r-md);
  color: var(--text-2);
  border: 1px solid var(--surface-border);
  transition:
    color var(--dur) var(--ease-smooth),
    border-color var(--dur) var(--ease-smooth),
    transform var(--dur-fast) var(--ease-spring);
}

.logout:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.logout:active:not(:disabled) {
  transform: scale(0.97);
}
</style>
