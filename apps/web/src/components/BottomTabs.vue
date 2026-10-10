<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();

const tabs = [
  { to: '/', label: '笔记', match: (p: string) => p === '/' || p.startsWith('/notes') },
  { to: '/folders', label: '文件夹', match: (p: string) => p.startsWith('/folders') },
  { to: '/settings', label: '设置', match: (p: string) => p.startsWith('/settings') },
];

function isActive(match: (path: string) => boolean): boolean {
  return match(route.path);
}
</script>

<template>
  <nav class="tabs glass">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.to"
      :to="tab.to"
      class="tab"
      :class="{ 'is-active': isActive(tab.match) }"
    >
      <span class="dot" aria-hidden="true" />
      {{ tab.label }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabs {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  display: flex;
  justify-content: space-around;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  padding-bottom: calc(var(--sp-1) + env(safe-area-inset-bottom, 0px));
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
  z-index: 6;
}

/* 桌面端导航交给侧边栏，底部标签栏退出 */
@media (min-width: 1024px) {
  .tabs {
    display: none;
  }
}

.tab {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  border-radius: var(--r-md);
  font-size: 12px;
  color: var(--text-2);
  text-decoration: none;
  transition:
    color var(--dur-fast) var(--ease-smooth),
    transform var(--dur-fast) var(--ease-spring);
}

.tab:active {
  transform: scale(0.96);
}

.dot {
  width: 20px;
  height: 20px;
  border-radius: 7px;
  background: currentColor;
  opacity: 0.28;
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.tab.is-active {
  color: var(--accent);
}

.tab.is-active .dot {
  opacity: 1;
}
</style>
