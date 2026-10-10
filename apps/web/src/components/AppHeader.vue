<script setup lang="ts">
/**
 * 顶栏（48px）。
 *
 * 两种形态二选一：
 * - 给了 crumbs 就渲染面包屑（列表 / 文件夹 / 回收站 / 设置这些层级清晰的页面）
 * - 否则渲染标题 + 副标题（笔记详情页这种「当前对象本身就有一个可编辑标题」的场景）
 *
 * 最左边那个按钮在桌面端是「收起侧边栏」，在移动端是「打开抽屉」，同一个 store 决定。
 */
import { useRouter } from 'vue-router';
import { useLayoutStore } from '@/stores/layout';
import ThemeToggle from './ThemeToggle.vue';

export interface Crumb {
  label: string;
  to?: string;
}

withDefaults(
  defineProps<{
    title?: string;
    subtitle?: string;
    /** 显示返回箭头（进入二级页面时用） */
    back?: boolean;
    /** 明确指定返回目标，缺省则用浏览器历史 */
    backTo?: string;
    /** 面包屑；给了就不显示 title */
    crumbs?: Crumb[];
  }>(),
  { title: '', subtitle: '', back: false, backTo: '', crumbs: () => [] },
);

const router = useRouter();
const layout = useLayoutStore();

function goBack(to: string): void {
  if (to) router.push(to);
  else if (window.history.length > 1) router.back();
  else router.push('/');
}
</script>

<template>
  <header class="topbar">
    <button class="icon-btn" type="button" aria-label="收起或展开侧边栏" @click="layout.toggle()">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M4.5 7h15M4.5 12h15M4.5 17h15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <button v-if="back" class="icon-btn" type="button" aria-label="返回" @click="goBack(backTo)">
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

    <nav v-if="crumbs.length" class="crumbs" aria-label="位置">
      <template v-for="(crumb, i) in crumbs" :key="`${crumb.label}-${i}`">
        <span v-if="i" class="sep" aria-hidden="true">/</span>
        <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb">{{ crumb.label }}</RouterLink>
        <span v-else class="crumb is-current" aria-current="page">{{ crumb.label }}</span>
      </template>
    </nav>

    <div v-else class="titles">
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>

    <div class="actions">
      <slot name="actions" />
      <ThemeToggle />
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--topbar-h);
  padding: 0 var(--page-gutter);
  padding-top: env(safe-area-inset-top, 0px);
  background: var(--glass-bg);
  border-bottom: 1px solid var(--divider);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  transition:
    background-color var(--dur) var(--ease-smooth),
    border-color var(--dur) var(--ease-smooth);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin-left: -6px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  flex: none;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.icon-btn + .icon-btn {
  margin-left: -2px;
}

.icon-btn:hover {
  background: var(--surface);
  color: var(--text);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.crumb {
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--dur-fast) var(--ease-smooth);
}

a.crumb:hover {
  color: var(--text);
}

.crumb.is-current {
  color: var(--text);
  font-weight: 600;
}

.sep {
  color: var(--text-2);
  opacity: 0.5;
  flex: none;
}

.titles {
  min-width: 0;
  flex: 1 1 auto;
}

.title {
  font-size: var(--fs-md);
  font-weight: 640;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subtitle {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
</style>
