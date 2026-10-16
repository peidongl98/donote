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
 * 只有一种形态：**常驻栏**。折叠与否、栏有多宽都记在本机。窗口缩到桌面端最小宽
 * （880px）也还是这条常驻栏 —— 不做抽屉、不做遮罩、不做底部标签栏，那些是手机形态，
 * 将来另写移动客户端时在那边做，不混进桌面壳（混进来的代价是拿视口宽度猜设备，
 * 880–1023px 这一段桌面窗口会被判成「手机」）。
 *
 * 真实状态写进 <html>：data-sidebar 决定「栏本身是否滑出」，--sidebar-w 决定宽度，
 * 而主内容让出的 --content-offset 只是 --sidebar-w 的别名（见 tokens.css）。
 * 所以调宽只需要改这一个变量，内容区、对话框、底部浮条就全都跟着走了，
 * 不用把宽度从这层一路 prop 传到距离很远的组件里。
 */
export const useLayoutStore = defineStore('layout', () => {
  /** 默认展开，用户明确折叠过才关 */
  const preferOpen = ref(typeof window !== 'undefined' ? localStorage.getItem(KEY) !== 'closed' : true);
  /** 栏宽，px */
  const width = ref(readWidth());
  /** 是否正在拖拽调宽（只影响跟随动画的时长和光标，不参与布局计算） */
  const resizing = ref(false);

  const open = computed(() => preferOpen.value);

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
    preferOpen.value = !preferOpen.value;
    localStorage.setItem(KEY, preferOpen.value ? 'open' : 'closed');
    apply();
  }

  /**
   * 创建时就先落一次：App.vue 也要等挂载后才渲染侧栏，那时首帧已经画过了，
   * 用户存的是 400px 的话会看到栏从 260 跳一下。宽度这么用显眼，值得提前一步。
   */
  apply();

  return {
    open,
    width,
    minWidth: WIDTH_MIN,
    maxWidth: WIDTH_MAX,
    resizing,
    setWidth,
    beginResize,
    commitWidth,
    resetWidth,
    toggle,
  };
});
