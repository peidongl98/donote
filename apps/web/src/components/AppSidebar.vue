<script setup lang="ts">
/**
 * 桌面端常驻侧边栏 / 移动端抽屉。
 *
 * 宽度由 CSS 变量 --sidebar-w 定，主内容让位靠 <html data-sidebar> 推导出的
 * --content-offset，两侧不会各算各的。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { notesApi } from '@/storage/notes';
import { useLayoutStore } from '@/stores/layout';
import { useUiStore } from '@/stores/ui';

const layout = useLayoutStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const creating = ref(false);

/**
 * 侧边栏搜索。
 *
 * 真正的搜索逻辑只有一份，在笔记列表页（它要拿 keyword 去问 notesApi.list）。
 * 这里不重复实现，只把关键词交给它 —— 搜完落在 `/`，关键词走 query，
 * 刷新和后退都能复现同一个结果。
 */
const keyword = ref('');

function search(): void {
  const term = keyword.value.trim();
  // 空关键词什么都不做：回车会把 form 的 submit 和 input 的 keydown 各触发一次，
  // 第二次进来时 keyword 已经清空，靠这个直接返回，不会把刚带上的 query 抹掉
  if (!term) return;
  layout.close(); // 手机上搜完把抽屉收起来，不然遮罩盖住结果
  keyword.value = '';
  void router.push({ path: '/', query: { q: term } });
}

const items = [
  { to: '/', label: '全部笔记', icon: 'notes' as const, match: (p: string) => p === '/' || p.startsWith('/notes') },
  { to: '/folders', label: '文件夹', icon: 'folder' as const, match: (p: string) => p.startsWith('/folders') },
  { to: '/trash', label: '回收站', icon: 'trash' as const, match: (p: string) => p.startsWith('/trash') },
  { to: '/settings', label: '设置', icon: 'gear' as const, match: (p: string) => p.startsWith('/settings') },
];

const isMobileDrawer = computed(() => !layout.desktop);

async function create(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const res = await notesApi.create({ title: '', content: '' });
    layout.close();
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败，请稍后重试');
  } finally {
    creating.value = false;
  }
}

/** 抽屉里点走一条路由就自动收起来，否则遮罩会盖住刚打开的页面 */
function onNavigate(): void {
  layout.close();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') layout.close();
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="isMobileDrawer && layout.open" class="scrim" @click="layout.close()" />

  <aside class="rail" :class="{ 'is-drawer': isMobileDrawer }" aria-label="主导航">
    <div class="brand">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M7 3h7.2L19 7.8V21H7Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linejoin="round"
          />
          <path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="name">DoNote</span>
      <button class="rail-close" type="button" aria-label="收起侧边栏" @click="layout.toggle()">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M14.5 5.5 8 12l6.5 6.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <form class="rail-search" role="search" @submit.prevent="search">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <input
        v-model="keyword"
        type="search"
        placeholder="搜索笔记"
        aria-label="在侧边栏搜索笔记"
        @keydown.enter.prevent="search"
      />
    </form>

    <button class="new" type="button" :disabled="creating" @click="create">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      新建笔记
    </button>

    <nav class="nav">
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ 'is-active': item.match(route.path) && route.path !== '/login' }"
        @click="onNavigate"
      >
        <svg v-if="item.icon === 'notes'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M6 3.75h9.5a2.75 2.75 0 0 1 2.75 2.75v13.75H8.75A2.75 2.75 0 0 1 6 17.5V3.75Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path d="M9.5 9h5M9.5 12.5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <svg v-else-if="item.icon === 'folder'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M3.5 6.75A1.75 1.75 0 0 1 5.25 5h3.4l1.7 2h8.4a1.75 1.75 0 0 1 1.75 1.75v7.5A1.75 1.75 0 0 1 18.75 18H5.25a1.75 1.75 0 0 1-1.75-1.75Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else-if="item.icon === 'trash'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M5.5 7h13M10 7V5.5h4V7M7 7l.9 12h8.2L17 7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="2.75" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        {{ item.label }}
      </RouterLink>
    </nav>

    <div class="rail-foot">
      <span class="hint">数据存在你自己的网盘</span>
    </div>
  </aside>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 19;
  background: rgba(6, 9, 18, 0.5);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  animation: scrim-in var(--dur-fast) var(--ease-smooth) both;
}

@keyframes scrim-in {
  from {
    opacity: 0;
  }
}

.rail {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 20;
  width: var(--sidebar-w);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) 12px;
  padding-top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  background: var(--rail-bg);
  border-right: 1px solid var(--surface-border);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  transform: translateX(0);
  transition:
    transform var(--dur) var(--ease-smooth),
    background-color var(--dur) var(--ease-smooth);
}

/* 收起：桌面端滑出画面，主内容靠 --content-offset 收回宽度 */
html[data-sidebar='closed'] .rail {
  transform: translateX(-100%);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 4px 8px 0;
}

.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  flex: none;
}

.name {
  font-size: var(--fs-md);
  font-weight: 680;
  letter-spacing: -0.01em;
  flex: 1 1 auto;
  min-width: 0;
}

.rail-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  flex: none;
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.rail-close:hover {
  background: var(--surface);
  color: var(--text);
}

.rail-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text-2);
  flex: none;
}

.rail-search:focus-within {
  border-color: var(--accent-ring);
  color: var(--text);
}

.rail-search input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  font-size: var(--fs-sm);
  color: var(--text);
  background: none;
  border: none;
}

.rail-search input:focus {
  outline: none;
}

.rail-search input::placeholder {
  color: var(--text-2);
  opacity: 0.75;
}

.new {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: 38px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-base);
  font-weight: 560;
  color: var(--on-accent);
  background: var(--accent);
  box-shadow: var(--shadow-1);
  transition:
    transform var(--dur-fast) var(--ease-spring),
    opacity var(--dur-fast) var(--ease-smooth);
}

.new:hover:not(:disabled) {
  transform: translateY(-1px);
}

.new:disabled {
  opacity: 0.6;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-decoration: none;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.nav-item svg {
  flex: none;
  opacity: 0.85;
}

.nav-item:hover {
  background: var(--surface);
  color: var(--text);
}

.nav-item.is-active {
  background: var(--rail-active);
  color: var(--text);
  font-weight: 600;
}

.nav-item.is-active svg {
  color: var(--accent);
  opacity: 1;
}

.rail-foot {
  margin-top: auto;
  padding: 0 10px;
}

.hint {
  font-size: var(--fs-xs);
  color: var(--text-2);
  opacity: 0.75;
}
</style>
