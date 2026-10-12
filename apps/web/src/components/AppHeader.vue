<script setup lang="ts">
/**
 * 顶栏（48px）。桌面端它同时是窗口标题栏 —— 窗口去掉了原生边框（decorations: false），
 * 拖动、最小化、最大化、关闭都得自己接。
 *
 * 两种形态二选一：
 * - 给了 crumbs 就渲染面包屑（列表 / 文件夹 / 回收站 / 设置这些层级清晰的页面）
 * - 否则渲染标题 + 副标题（笔记详情页这种「当前对象本身就有一个可编辑标题」的场景）
 *
 * 最左边那个按钮在桌面端是「收起侧边栏」，在移动端是「打开抽屉」，同一个 store 决定。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLayoutStore } from '@/stores/layout';
import { useSyncStore } from '@/stores/sync';
import { isTauriRuntime } from '@/storage/transport';
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
const sync = useSyncStore();

/** 只有端上才是无边框窗口，才需要这套按钮 */
const isDesktop = isTauriRuntime();
const maximized = ref(false);
let stopWatching: (() => void) | null = null;

function goBack(to: string): void {
  if (to) router.push(to);
  else if (window.history.length > 1) router.back();
  else router.push('/');
}

onMounted(async () => {
  if (!isDesktop) return;
  const win = getCurrentWindow();
  maximized.value = await win.isMaximized().catch(() => false);
  // 用窗口自己的 onResized，不用全局 tauri://resize —— 后者对 toggleMaximize
  // 这类「合成」尺寸变化并不可靠，图标会跟不上
  stopWatching = await win.onResized(() => {
    void win.isMaximized().then((value) => (maximized.value = value));
  });
});

onUnmounted(() => stopWatching?.());

function minimize(): void {
  void getCurrentWindow().minimize();
}

async function toggleMaximize(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
  maximized.value = await getCurrentWindow().isMaximized().catch(() => maximized.value);
}

function closeWindow(): void {
  void getCurrentWindow().close();
}
</script>

<template>
  <header class="topbar" data-tauri-drag-region>
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

    <!-- drag-region 只认「被点到的那个元素」，所以每块非交互区域都要自己带上 -->
    <nav
      v-if="crumbs.length"
      class="crumbs"
      aria-label="位置"
      data-tauri-drag-region
    >
      <template v-for="(crumb, i) in crumbs" :key="`${crumb.label}-${i}`">
        <span v-if="i" class="sep" aria-hidden="true">/</span>
        <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb">{{ crumb.label }}</RouterLink>
        <span v-else class="crumb is-current" aria-current="page">{{ crumb.label }}</span>
      </template>
    </nav>

    <div v-else class="titles" data-tauri-drag-region>
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>

    <div class="actions">
      <slot name="actions" />
      <span
        v-if="sync.usable"
        class="sync-dot"
        :class="`is-${sync.tone}`"
        :title="sync.label"
        :aria-label="sync.label"
        role="status"
      />
      <ThemeToggle />

      <div v-if="isDesktop" class="win-controls">
        <button class="win-btn" type="button" aria-label="最小化" @click="minimize">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M1.5 6h9" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
        <button
          class="win-btn"
          type="button"
          :aria-label="maximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          <svg v-if="maximized" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              d="M3.5 3.5V1.5h7v7h-2M1.5 3.5h7v7h-7z"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
          <svg v-else viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        </button>
        <button class="win-btn is-close" type="button" aria-label="关闭" @click="closeWindow">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="m1.5 1.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="1.1" />
          </svg>
        </button>
      </div>
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

/* 同步状态点：绿=已同步，黄=有待推改动/冲突，灰=离线用缓存 */
.sync-dot {
  width: 8px;
  height: 8px;
  margin-right: 2px;
  border-radius: var(--r-pill);
  background: var(--text-2);
  flex: none;
  transition: background-color var(--dur) var(--ease-smooth);
}

.sync-dot.is-online {
  background: #3fb950;
  box-shadow: 0 0 0 3px rgb(63 185 80 / 16%);
}

.sync-dot.is-pending {
  background: #d29922;
  box-shadow: 0 0 0 3px rgb(210 153 34 / 18%);
}

.sync-dot.is-offline {
  background: var(--text-2);
  opacity: 0.7;
}

/* 窗口按钮贴着右上角，所以抵消掉顶栏的右内边距 */
.win-controls {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  margin-right: calc(var(--page-gutter) * -1);
  margin-left: 4px;
}

.win-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.win-btn:hover {
  background: var(--surface);
  color: var(--text);
}

.win-btn.is-close:hover {
  background: #c42b1c;
  color: #fff;
}
</style>
