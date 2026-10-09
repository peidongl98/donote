<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import GlassCard from '@/components/GlassCard.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const auth = useAuthStore();
const router = useRouter();

const displayName = computed(() => auth.user?.nickname || auth.user?.phone || '');
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase() || 'N');
const items = ['我的笔记', '文件夹', '分享管理', '设置'];

async function onLogout(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <main class="home">
    <div class="wrap">
      <header class="bar">
        <div class="who">
          <span class="avatar" aria-hidden="true">{{ initial }}</span>
          <div class="meta">
            <p class="hello">你好，{{ displayName }}</p>
            <p class="tenant mono">{{ auth.tenant?.name ?? '—' }} · {{ auth.tenant?.plan ?? 'free' }}</p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <GlassCard class="welcome lift">
        <h2 class="welcome-title">笔记列表将在这里出现</h2>
        <p class="welcome-sub">本批只完成认证与骨架，笔记 CRUD / Markdown 渲染在下一批开放。</p>
      </GlassCard>

      <ul class="entries">
        <li v-for="(item, index) in items" :key="item" class="entry" :style="{ animationDelay: `${index * 60}ms` }">
          <span class="entry-name">{{ item }}</span>
          <span class="entry-tag">待开放</span>
        </li>
      </ul>

      <button class="logout" @click="onLogout">退出登录</button>
    </div>
  </main>
</template>

<style scoped>
.home {
  padding: var(--sp-3) 0 var(--sp-5);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.who {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  flex: none;
}

.meta {
  min-width: 0;
}

.hello {
  font-size: 16px;
  font-weight: 600;
}

.tenant {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.welcome {
  margin-bottom: var(--sp-3);
}

.welcome-title {
  font-size: 18px;
}

.welcome-sub {
  margin-top: var(--sp-1);
  font-size: 14px;
  color: var(--text-2);
}

.entries {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

/* 列表项错位淡入 */
.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition:
    background-color var(--dur) var(--ease-smooth),
    transform var(--dur) var(--ease-spring);
  animation: entry-in var(--dur-slow) var(--ease-smooth) both;
}

.entry:hover {
  transform: translateY(-1px);
}

.entry-name {
  font-size: 15px;
}

.entry-tag {
  font-size: 12px;
  color: var(--text-2);
}

@keyframes entry-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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

.logout:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.logout:active {
  transform: scale(0.97);
}
</style>
