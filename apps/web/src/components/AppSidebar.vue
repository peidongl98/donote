<script setup lang="ts">
/**
 * 桌面端常驻侧边栏 / 移动端抽屉。
 *
 * 宽度由 CSS 变量 --sidebar-w 定，主内容让位靠 <html data-sidebar> 推导出的
 * --content-offset，两侧不会各算各的。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { notesApi } from '@/storage/notes';
import { useSyncStore } from '@/stores/sync';
import { useWebdavStore } from '@/stores/webdav';
import { useLayoutStore } from '@/stores/layout';
import { useUiStore } from '@/stores/ui';
import SidebarTree from '@/components/SidebarTree.vue';
import ImportButton from '@/components/ImportButton.vue';

const layout = useLayoutStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

const creating = ref(false);
/** 导入完递增一次，让树重取目录（导入走 notesApi.create，不经过 sync.dataVersion） */
const reloadToken = ref(0);

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
  keyword.value = '';
  void router.push({ path: '/', query: { q: term } });
}

interface NavItem {
  kind: 'nav';
  to: string;
  label: string;
  icon: 'notes' | 'folder' | 'trash' | 'gear';
  match: (path: string) => boolean;
}

const notesItem: NavItem = {
  kind: 'nav',
  to: '/',
  label: '全部笔记',
  icon: 'notes',
  match: (p) => p === '/' || p.startsWith('/notes'),
};
const foldersItem: NavItem = {
  kind: 'nav',
  to: '/folders',
  label: '文件夹',
  icon: 'folder',
  // 只有 /folders 列表页算「文件夹」这一项；进了某个文件夹之后由树里那一行高亮，
  // 两边都亮会看不出「现在到底在哪一层」
  match: (p) => p === '/folders',
};
const trashItem: NavItem = {
  kind: 'nav',
  to: '/trash',
  label: '回收站',
  icon: 'trash',
  match: (p) => p.startsWith('/trash'),
};
const settingsItem: NavItem = {
  kind: 'nav',
  to: '/settings',
  label: '设置',
  icon: 'gear',
  match: (p) => p.startsWith('/settings'),
};

/**
 * 导航排布：全部笔记 / 文件夹 → **文件夹树** → 回收站 / 设置。
 * 树用 `{ kind: 'tree' }` 占位，这样一个 v-for 就能排完，不用把图标那几十行 SVG 复制成两组。
 *
 * 🔴 树挂在 `layout.open` 上：折叠时不挂载 —— 一直挂着就等于折叠状态下也白付一次目录遍历；
 * 展开时再挂，数据走 `tree()` 的模块缓存，立刻就有。
 */
type NavEntry = NavItem | { kind: 'tree' };

const entries: NavEntry[] = [
  notesItem,
  foldersItem,
  { kind: 'tree' },
  trashItem,
  settingsItem,
];

/**
 * 标签清单。数据变了（新建 / 改名 / 存盘 / 后台校验出云端有更新）就重算一次 ——
 * 用 sync store 已有的 dataVersion 当信号，不再自己订阅一次 subscribeData。
 * 标签是从摘要那份缓存里来的，重算不额外发请求。
 */
const allTags = ref<Array<{ name: string; count: number }>>([]);
const sync = useSyncStore();
const webdav = useWebdavStore();

/** 侧栏底部那句「数据存在哪」：本地模式不该说成网盘 */
const dataPlaceText = computed(() => (webdav.isLocal ? '数据存在这台电脑上' : '数据存在你自己的网盘'));

async function loadTags(): Promise<void> {
  if (!layout.open) {
    allTags.value = [];
    return;
  }
  try {
    allTags.value = await notesApi.tags();
  } catch {
    // 标签拉不到不影响导航
  }
}

onMounted(async () => {
  await loadTags();
  watch(() => sync.dataVersion, () => void loadTags());
});
watch(() => layout.open, () => void loadTags());
watch(() => route.fullPath, () => void loadTags());

async function create(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const res = await notesApi.create({ title: '', content: '' });
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败，请稍后重试');
  } finally {
    creating.value = false;
  }
}

/** 导入完：树重取一次（新文件夹 / 新笔记要立刻看得见），标签也跟着重算 */
async function onImported(): Promise<void> {
  reloadToken.value += 1;
  await loadTags();
}

/**
 * 侧边栏宽度拖拽。
 *
 * 栏贴在视口左边，所以指针的 clientX 就是想要的宽度 —— 不用减去栏的 left，也不用记按下时的偏移，
 * 手柄始终跟着指针走。宽度写进 store 后就自动落到 --sidebar-w，主内容让位是同一个变量，
 * 这里不需要同步任何别的东西。
 */
function startResize(e: PointerEvent): void {
  if (e.button !== 0) return;
  // 必须吃掉 pointerdown 的默认行为。否则按住往左快拖时，指针一旦离开侧栏落到正文上，
  // Chromium 会把它当成「拖选那段文字」，发一个 dragstart 并立刻用 pointercancel 掐断
  // 整个指针序列 —— 表现是「往左拖到一半就停住，再拖没反应」（实测停在 391px）。
  // 往右拖之所以看不出问题，是因为指针始终在栏内，没发生这次命中判定。
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  // preventDefault 会挡掉点按聚焦这个默认行为，键盘操作要靠它，所以手动补回来
  handle.focus();
  // 捕获指针：手快速拖到栏外（甚至窗口外）也不丢事件
  handle.setPointerCapture(e.pointerId);
  layout.beginResize();
  const move = (ev: PointerEvent): void => layout.setWidth(ev.clientX);
  const finish = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    layout.commitWidth();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

/** 键盘备选：手柄拿到焦点后用左右方向键推，每次 16px */
const RESIZE_STEP = 16;

function onResizeKey(e: KeyboardEvent): void {
  const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (dir === 0) return;
  e.preventDefault();
  layout.setWidth(layout.width + dir * RESIZE_STEP);
  layout.commitWidth();
}
</script>

<template>
  <aside class="rail" aria-label="主导航">
    <div class="brand">
      <span class="logo" aria-hidden="true">
        <img src="/favicon.svg" alt="" width="28" height="28" />
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

    <div class="new-row">
      <button class="new" type="button" :disabled="creating" @click="create">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        新建笔记
      </button>
      <ImportButton compact label="导入" @done="onImported" />
    </div>

    <nav class="nav">
      <template v-for="entry in entries" :key="entry.kind === 'tree' ? '__tree__' : entry.to">
        <template v-if="entry.kind === 'tree'">
          <SidebarTree v-if="layout.open" :reload-token="reloadToken" />
        </template>

        <RouterLink
          v-else
          :to="entry.to"
          class="nav-item"
          :class="{ 'is-active': entry.match(route.path) && route.path !== '/login' }"
        >
          <svg v-if="entry.icon === 'notes'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M6 3.75h9.5a2.75 2.75 0 0 1 2.75 2.75v13.75H8.75A2.75 2.75 0 0 1 6 17.5V3.75Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path d="M9.5 9h5M9.5 12.5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <svg v-else-if="entry.icon === 'folder'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M3.5 6.75A1.75 1.75 0 0 1 5.25 5h3.4l1.7 2h8.4a1.75 1.75 0 0 1 1.75 1.75v7.5A1.75 1.75 0 0 1 18.75 18H5.25a1.75 1.75 0 0 1-1.75-1.75Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </svg>
          <svg v-else-if="entry.icon === 'trash'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
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
          {{ entry.label }}
        </RouterLink>
      </template>

      <!-- 标签：列出所有出现过的标签，点一个就只看带它的笔记。
           数据取 notesApi.tags()（走摘要那份缓存，不额外发请求），列表变了跟着刷。 -->
      <div v-if="layout.open && allTags.length" class="tag-block">
        <p class="tag-title">标签</p>
        <RouterLink
          v-for="tag in allTags"
          :key="tag.name"
          class="tag-item"
          :class="{ 'is-active': route.query.tag === tag.name }"
          :to="{ path: '/', query: { tag: tag.name } }"
        >
          <span class="tag-hash">#</span>
          <span class="tag-name">{{ tag.name }}</span>
          <span class="tag-count">{{ tag.count }}</span>
        </RouterLink>
      </div>
    </nav>

    <div class="rail-foot">
      <span class="hint">{{ dataPlaceText }}</span>
    </div>

    <!--
      宽度手柄。双击回到默认宽度，键盘左右方向键也能推。
    -->
    <div
      class="rail-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边栏宽度"
      :aria-valuenow="layout.width"
      :aria-valuemin="layout.minWidth"
      :aria-valuemax="layout.maxWidth"
      tabindex="0"
      @pointerdown="startResize"
      @dblclick="layout.resetWidth()"
      @keydown="onResizeKey"
    />
  </aside>
</template>

<style scoped>
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

/* 收起：滑出画面，主内容靠 --content-offset 收回宽度 */
html[data-sidebar='closed'] .rail {
  transform: translateX(-100%);
}

/*
 * 宽度手柄：骑在栏的右边界上（左右各占 3px），视觉上是一条 6px 的透明带，
 * 平时不可见、不占布局宽度，悬停 / 聚焦 / 拖拽时才亮出一条强调色细线。
 * touch-action 关掉是必须的 —— 否则触屏/精密触控板会把手势判成滚动，pointermove 直接断掉。
 */
.rail-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
  z-index: 2;
  outline: none;
}

.rail-resizer::after {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 3px;
  width: 1px;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.rail-resizer:hover::after,
.rail-resizer:focus-visible::after,
html[data-resizing] .rail-resizer::after {
  opacity: 0.5;
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
  overflow: hidden;
  flex: none;
}

/* 图标自带蓝渐变底，容器不再叠一层 accent 底色 */
.logo img {
  display: block;
  width: 100%;
  height: 100%;
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

/* 新建笔记 + 导入：两个入口并排，导入只占一个方块 */
.new-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
  flex: none;
}

.new {
  flex: 1 1 auto;
  min-width: 0;
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
  /*
   * 导航整体吃掉剩余高度：里面的树（SidebarTree）靠 flex:1 + overflow-y 自己滚，
   * 下面的 rail-foot 因此不用再靠 margin-top:auto 顶到底。
   */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  flex: none;
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

/* 标签块：与树同一档缩进，行内三段（# / 名字 / 计数） */
.tag-block {
  margin: 10px 0 2px;
  padding: 0 8px;
}

.tag-title {
  margin: 0 0 4px 4px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  opacity: 0.8;
}

.tag-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--r-xs);
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-decoration: none;
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.tag-item:hover {
  background: var(--surface);
  color: var(--text);
}

.tag-item.is-active {
  background: var(--rail-active);
  color: var(--accent);
}

.tag-hash {
  opacity: 0.6;
}

.tag-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-count {
  font-size: var(--fs-xs);
  opacity: 0.7;
}
</style>
