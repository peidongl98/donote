import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const KEY = 'donote.sidebar';
const WIDTH_KEY = 'donote.sidebar-w';

/**
 * 侧边栏宽度的默认值与可调范围。
 *
 * 上限 520 是「再宽就该用文件夹页了」的经验值：窗口拉到最小（880px）时拖到顶，
 * 内容列还剩 360px，读得下去；下限 200 是搜索框 + 「新建笔记 / 导入」两个按钮
 * 并排还能看全的宽度。夹取只写在这里，CSS 那边不重复一遍。
 */
const WIDTH_DEFAULT = 260;
const WIDTH_MIN = 200;
const WIDTH_MAX = 520;

function clampWidth(px: number): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(px)));
}

function readWidth(): number {
  if (typeof localStorage === 'undefined') return WIDTH_DEFAULT;
  const n = Number.parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10);
  return Number.isFinite(n) ? clampWidth(n) : WIDTH_DEFAULT;
}

/**
 * 侧边栏状态。
 *
 * 两种形态：
 * - 宽屏（> 600px）：**常驻栏**。折叠与否、栏有多宽都记在本机。
 * - 窄屏（≤ 600px，手机）：**抽屉**。从左侧盖上来，主内容不让位；关掉记忆，
 *   每次进入都是收起的（手机上一进来就被抽屉占掉半屏是最糟的默认）。
 *
 * 判据只有视口宽度一条。不拿 UA / pointer 猜设备 —— 同一份产物在 Windows 窗口、
 * 平板、手机上跑，猜的那两种都会各错一次。平板竖屏（实测 720 CSS px）落在常驻栏区间，
 * 那里两栏还撑得住。
 *
 * 真实状态写进 <html>：data-sidebar 决定「栏本身是否滑出」，--sidebar-w 决定宽度，
 * 而主内容让出的 --content-offset 只是 --sidebar-w 的别名（见 tokens.css，
 * 窄屏那份覆盖成 0）。所以调宽只需要改这一个变量，内容区、对话框、底部浮条就全都跟着走了，
 * 不用把宽度从这层一路 prop 传到距离很远的组件里。
 */
export const useLayoutStore = defineStore('layout', () => {
  /**
   * 手机形态的判据：**壳上报的设备类型**（<html data-device>，见 storage/harmony.ts），
   * 不是视口宽度。平板是 920 CSS px，与拖窄的桌面窗口重叠，按宽度分必然错一边。
   * 桌面端没有这个属性 → 恒为常驻栏，行为与改前一致。
   */
  const isNarrow = ref(
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-device') === 'phone',
  );
  /** 默认展开，用户明确折叠过才关（仅宽屏） */
  const preferOpen = ref(typeof window !== 'undefined' ? localStorage.getItem(KEY) !== 'closed' : true);
  /** 窄屏抽屉是否展开。每次启动都从收起开始，不落盘 */
  const drawer = ref(false);
  /** 栏宽，px */
  const width = ref(readWidth());
  /** 是否正在拖拽调宽（只影响跟随动画的时长和光标，不参与布局计算） */
  const resizing = ref(false);

  const open = computed(() => (isNarrow.value ? drawer.value : preferOpen.value));

  function apply(): void {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.setAttribute('data-sidebar', open.value ? 'open' : 'closed');
    el.style.setProperty('--sidebar-w', `${width.value}px`);
    if (resizing.value) el.setAttribute('data-resizing', '1');
    else el.removeAttribute('data-resizing');
  }

  /** 拖拽过程中逐帧调用，不落盘 —— 每帧写一次 localStorage 没有必要 */
  function setWidth(px: number): void {
    const next = clampWidth(px);
    if (next === width.value) return;
    width.value = next;
    apply();
  }

  function beginResize(): void {
    resizing.value = true;
    apply();
  }

  /** 一次调整结束（松手 / 改完键盘）才落盘 */
  function commitWidth(): void {
    resizing.value = false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(WIDTH_KEY, String(width.value));
    apply();
  }

  /** 双击手柄回到默认宽度：拖飞了有个一步可退的地方 */
  function resetWidth(): void {
    width.value = WIDTH_DEFAULT;
    commitWidth();
  }

  function toggle(): void {
    if (isNarrow.value) {
      drawer.value = !drawer.value;
      apply();
      return;
    }
    preferOpen.value = !preferOpen.value;
    localStorage.setItem(KEY, preferOpen.value ? 'open' : 'closed');
    apply();
  }

  /** 关抽屉。窄屏下点了导航就该收起来，否则用户还得再点一次遮罩 */
  function closeDrawer(): void {
    if (!isNarrow.value || !drawer.value) return;
    drawer.value = false;
    apply();
  }

  /**
   * 设备标记是壳在启动时写到 <html> 上的，而 store 有可能比它早一步创建
   * （实测会：首帧读到的 data-device 为空，于是按宽屏渲染成常驻栏）。
   * 盯住这个属性，晚到也能纠正过来 —— 只监听 data-device，apply() 写的
   * data-sidebar 不会自己触发自己。
   */
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const observer = new MutationObserver(() => {
      const next = document.documentElement.getAttribute('data-device') === 'phone';
      if (next === isNarrow.value) return;
      isNarrow.value = next;
      drawer.value = false;
      apply();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-device'] });
  }

  /**
   * 创建时就先落一次：App.vue 也要等挂载后才渲染侧栏，那时首帧已经画过了，
   * 用户存的是 400px 的话会看到栏从 260 跳一下。宽度这么用显眼，值得提前一步。
   */
  apply();

  return {
    open,
    isNarrow,
    width,
    minWidth: WIDTH_MIN,
    maxWidth: WIDTH_MAX,
    resizing,
    setWidth,
    beginResize,
    commitWidth,
    resetWidth,
    toggle,
    closeDrawer,
  };
});
