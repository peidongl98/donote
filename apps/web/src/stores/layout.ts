import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const KEY = 'donote.sidebar';
const DESKTOP = '(min-width: 1024px)';

/**
 * 侧边栏状态。
 *
 * 桌面端（≥1024px）是常驻栏，用户折叠与否记在本机；移动端是抽屉，
 * 只在当前会话里有效、不落盘 —— 否则手机上每次进来都被盖一层遮罩。
 *
 * 真实状态写进 <html data-sidebar>，CSS 靠它同时决定「栏本身是否滑出」和
 * 「主内容让出多少宽度」，不用 JS 传 prop 给距离很远的组件。
 */
export const useLayoutStore = defineStore('layout', () => {
  const desktop = ref(typeof window !== 'undefined' && window.matchMedia(DESKTOP).matches);
  /** 桌面端偏好：默认展开，用户明确折叠过才关 */
  const preferOpen = ref(typeof window !== 'undefined' ? localStorage.getItem(KEY) !== 'closed' : true);
  /** 移动端抽屉，不落盘 */
  const drawerOpen = ref(false);

  const open = computed(() => (desktop.value ? preferOpen.value : drawerOpen.value));

  function apply(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-sidebar', open.value ? 'open' : 'closed');
  }

  function toggle(): void {
    if (desktop.value) {
      preferOpen.value = !preferOpen.value;
      localStorage.setItem(KEY, preferOpen.value ? 'open' : 'closed');
    } else {
      drawerOpen.value = !drawerOpen.value;
    }
    apply();
  }

  function close(): void {
    if (desktop.value) return;
    drawerOpen.value = false;
    apply();
  }

  /** 跨过断点时按当前设备的默认口径重算，避免桌面折叠状态带到手机上 */
  function init(): void {
    const mq = window.matchMedia(DESKTOP);
    desktop.value = mq.matches;
    mq.addEventListener('change', (e) => {
      desktop.value = e.matches;
      drawerOpen.value = false;
      apply();
    });
    apply();
  }

  return { desktop, open, toggle, close, init };
});
