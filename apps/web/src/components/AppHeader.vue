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
import { useRoute, useRouter } from 'vue-router';
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
    /**
     * 手机上只留按钮、不留字（标题 / 面包屑 / 抽屉按钮都收掉）。
     * 编辑页用：那一页的标题就在顶栏正下方，重复一遍只会把按钮挤出去。
     * 桌面端不受影响 —— 这个开关只在 `html[data-device='phone']` 下生效。
     */
    bare?: boolean;
  }>(),
  { title: '', subtitle: '', back: false, backTo: '', crumbs: () => [], bare: false },
);

const router = useRouter();
const route = useRoute();
const layout = useLayoutStore();
const sync = useSyncStore();

/**
 * 「全部笔记」是全局出口：笔记页换一篇会留一条历史记录，返回键要按几次才回到列表，
 * 这里给一个一键到底的入口。已经在列表页时它没有意义，所以隐藏而不是禁用。
 */
function goHome(): void {
  void router.push('/');
}

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
  <!--
    drag-region 用 "deep"：Tauri 的拖拽脚本沿 composedPath 向上找，但**裸属性
    （无值 / "true"）只认被直接点到的那个元素**（`return el === composedPath[0]`），
    所以把裸属性挂在 .titles 上时，点到里面的 <h1> 就整块拖不动。
    "deep" 表示「子树里任何位置都算拖拽区」，内层的按钮 / 链接 / 输入框仍会自己拦住
    （脚本对 A / BUTTON / INPUT … 这些可点元素直接返回 false），不影响点击。
    注意：**不要**在内层再挂裸属性，裸属性会短路整条向上查找，反而把 "deep" 挡掉。
  -->
  <header class="topbar" :class="{ 'is-bare': bare }" data-tauri-drag-region="deep">
    <button
      class="icon-btn menu-btn"
      type="button"
      aria-label="收起或展开侧边栏"
      @click="layout.toggle()"
    >
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

    <button
      v-if="route.path !== '/'"
      class="icon-btn"
      type="button"
      aria-label="全部笔记"
      title="全部笔记"
      @click="goHome"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M4.5 10.6 12 4.6l7.5 6V19a1.2 1.2 0 0 1-1.2 1.2H5.7A1.2 1.2 0 0 1 4.5 19z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
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

    <nav
      v-if="crumbs.length"
      class="crumbs"
      aria-label="位置"
    >
      <template v-for="(crumb, i) in crumbs" :key="`${crumb.label}-${i}`">
        <span v-if="i" class="sep" aria-hidden="true">/</span>
        <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb">{{ crumb.label }}</RouterLink>
        <span v-else class="crumb is-current" aria-current="page">{{ crumb.label }}</span>
      </template>
    </nav>

    <div v-else class="titles">
      <h1 v-if="title" class="title">{{ title }}</h1>
      <p v-if="subtitle || $slots.subtitle" class="subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
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

      <div v-if="isDesktop" class="win-controls" :class="{ 'is-maximized': maximized }">
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
  /*
   * 顶栏是 .page（flex 列）的第一项，内容再长也不许被压扁 ——
   * 默认 flex-shrink: 1 会跟滚动区一起按比例缩，48px 的标题栏会被挤矮。
   */
  flex: none;
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  height: calc(var(--topbar-h) + var(--safe-top));
  padding: 0 var(--page-gutter);
  /* 全屏窗口下顶栏要自己让开状态栏，否则标题会压在时间/电量上 */
  padding-top: var(--safe-top);
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

/*
 * 副标题位是「文件元信息」的位置（文件夹名 + 保存状态这类），
 * 所以是 flex 行：几段信息并排、各自可截断，不换行把顶栏撑高。
 */
.subtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  /*
   * 撑满顶栏，窗口按钮区才有 48px 可贴 —— 默认按内容撑高（≈41px）再垂直居中，
   * 关闭按钮的红色块上下各会露 3px 顶栏底色，看着像没贴边。
   * 其余子项靠 align-items: center 保持居中，不受影响。
   */
  align-self: stretch;
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
  /*
   * 窗口是无边框的，右上角圆角由 DWM 裁（Win11 = 8px 逻辑像素）；
   * hover 底色是直角矩形，不跟这个角就是月牙形缺口，一眼看出没贴边。
   * 最大化时系统不裁圆角，所以这里要跟着回到直角。
   */
  --win-corner: 8px;
}

.win-controls.is-maximized {
  --win-corner: 0px;
}

.win-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  /*
   * 顶栏下沿有 1px 分隔线。不吃掉它，hover 底色就压不到窗口边缘，
   * 红块下面会留一条灰线 —— 只有 hover 时看得见，但正是「不贴边」的来源。
   */
  margin-bottom: -1px;
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.win-btn:hover {
  background: var(--surface);
  color: var(--text);
}

/* 只有最右这个按钮压在窗口右上角上，圆角只给它 */
.win-btn.is-close {
  border-top-right-radius: var(--win-corner);
}

.win-btn.is-close:hover {
  background: #c42b1c;
  color: #fff;
}

/*
 * 触屏（平板 / 手机，<html data-touch> 由壳上报）。
 * 这一档要解决的是「顶栏显示不全」：顶栏高 48px、图标 32px、面包屑按全路径铺开，
 * 在 920px 宽的平板上再叠上右侧那排动作按钮就放不下了 —— 右边的按钮被挤出可视区。
 * 做法是三条：抬高顶栏（tokens 里已改 56px）让图标能长到 40px 触控尺寸、
 * 面包屑只留当前层（路径在窄屏上没有信息价值，反而挤掉按钮）。
 */
html[data-touch='1'] .topbar {
  gap: 4px;
}

html[data-touch='1'] .icon-btn {
  width: 40px;
  height: 40px;
  margin-left: 0;
  border-radius: var(--r-sm);
}

html[data-touch='1'] .icon-btn + .icon-btn {
  margin-left: 0;
}

/* 面包屑只保留最后一段（当前页），前面的层级交给返回箭头 */
html[data-touch='1'] .crumbs > :not(.is-current) {
  display: none;
}

html[data-touch='1'] .crumb {
  font-size: var(--fs-base);
}

/*
 * 手机：当前页名按剩余宽度截断成「pract…」。
 * 不写这两条的话，flex 会把这段文字压到只剩一个字的宽度 ——
 * 编辑页实测就剩「p」加半个标点，看着像坏了。
 */
html[data-device='phone'] .crumbs {
  flex: 1 1 auto;
  min-width: 0;
}

html[data-device='phone'] .crumb {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

html[data-touch='1'] .sep {
  display: none;
}

/* 手机：再放大一档，让拇指点得准 */
html[data-device='phone'] .icon-btn {
  width: 44px;
  height: 44px;
}

html[data-device='phone'] .topbar {
  padding-left: 8px;
  padding-right: 8px;
}

/*
 * 手机：主题开关让位。
 * 编辑页这一排是 6 个 44px 图标 + 更多 + 主题，378 CSS px 上还差 20px ——
 * 实测主题开关整块被推出右边界，只看得见半个太阳。主题在设置页里照样能切，
 * 顶栏优先留给「撤销 / 重做 / 源码 / 更多」这些编稿时真正按的键。
 */
html[data-device='phone'] .actions > .toggle {
  display: none;
}

/*
 * 手机上的「只留按钮」形态（编辑页用，见 NoteEditView 的 bare）。
 *
 * 这个页面的标题就在顶栏正下方，面包屑再写一遍只会把右侧那排按钮挤出屏幕；
 * 抽屉按钮也一并收掉 —— 主页按钮回列表，要导航从列表页开抽屉。
 * 桌面端不受影响：这些规则都挂在 data-device='phone' 下面。
 */
html[data-device='phone'] .topbar.is-bare .menu-btn,
html[data-device='phone'] .topbar.is-bare .crumbs,
html[data-device='phone'] .topbar.is-bare .titles {
  display: none;
}

/* 只剩按钮了，右侧那排靠右对齐，不再被标题占位影响 */
html[data-device='phone'] .topbar.is-bare .actions {
  margin-left: auto;
}

/* ==========================================================================
   移动端的顶栏收放（阅读态自动隐藏，见 utils/auto-hide-bars.ts）
   --------------------------------------------------------------------------
   为什么要把顶栏从「流内 sticky」改成「固定覆盖层」：
   sticky 的位移只影响自己，收起来会在顶部留一条 56px 的空带；而给它设负 margin
   或者缩高度都是布局变化，每一帧都要重排一次正文，滚起来就是抖的。
   改成 fixed 之后，收 = `transform: translateY(-100%)`，只走合成层，
   正文一动不动地继续往上滚，视觉上就是「栏滑走了、字接着走」。
   代价已经由 app.css 里 `.page` 的 padding-top 还回来了。
   ========================================================================== */
html[data-touch='1'] .topbar {
  position: fixed;
  top: 0;
  left: var(--content-offset);
  right: 0;
  /* 提前提层：不写的话，第一次滑动才临时建层，正好卡在那一帧上 */
  will-change: transform;
  transform: translate3d(0, 0, 0);
  transition:
    transform var(--bars-dur) var(--bars-ease),
    /* 平板上侧栏收合时，顶栏要跟着内容区一起平移，否则会「跳」一下 */
    left var(--follow-dur) var(--ease-smooth),
    background-color var(--dur) var(--ease-smooth),
    border-color var(--dur) var(--ease-smooth);
}

html[data-touch='1'][data-bars='hidden'] .topbar {
  transform: translate3d(0, -100%, 0);
}

/* 收起来时它已经不在画面里，别再吃上面的点击（拖动选区时会卡住拖不出去） */
html[data-touch='1'][data-bars='hidden'] .topbar {
  pointer-events: none;
}
</style>
