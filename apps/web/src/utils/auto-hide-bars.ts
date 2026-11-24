/**
 * 移动端阅读态：往下读的时候把顶栏收起来，往上滚一点它自己回来。
 *
 * 只用一条信号 —— **滚动方向 + 距顶距离**：
 * - 距顶 40px 以内永远显示。回到顶部时栏一定在场，不会出现「栏藏起来了、叫回来没门」；
 * - 单向累计超过 10px 才切换。手指按住时的抖动、惯性尾巴里的小回弹都不算数；
 * - 键盘弹出（focusin）与切页时强制显示 —— 这两件事发生时用户正要输入或正要找路。
 *
 * 不猜设备：只认壳写上的 `<html data-touch>`（见 storage/harmony.ts）。
 * 桌面端没有这个属性，这一套监听在那边什么也不做，顶栏照旧是流内的。
 *
 * 状态只写一个属性 `data-bars="hidden"`，动效全交给 CSS（见 AppHeader）：
 * 这里是「什么时候收」，那里是「怎么收」。
 */
const TOP_ZONE = 40;
const STEP = 10;

let installed = false;
/** 上次判定时的 scrollTop：用它累积位移，避免每 2px 抖一下就切一次状态 */
let anchor = 0;
let hidden = false;

function root(): HTMLElement {
  return document.documentElement;
}

/** 显示顶栏。切页、聚焦输入、回到顶部都走这里 */
export function showBars(): void {
  if (typeof document === 'undefined') return;
  hidden = false;
  root().removeAttribute('data-bars');
}

/** 切页时连锚点一起清掉：新页面从顶部开始，不该继承上一篇的滚动位置 */
export function resetBars(): void {
  anchor = 0;
  showBars();
}

function hideBars(): void {
  if (hidden) return;
  hidden = true;
  root().setAttribute('data-bars', 'hidden');
}

function onScroll(event: Event): void {
  if (root().dataset.touch !== '1') return;
  const el = event.target;
  // 文档级滚动不参与：这个应用里滚的都是 .page-body / 编辑区这类容器
  if (!(el instanceof HTMLElement) || el === root() || el === document.body) return;
  // 抽屉自己内部滚动时，收的是顶栏（在遮罩底下），没有意义
  if (el.closest('.rail')) return;

  const top = el.scrollTop;
  if (top <= TOP_ZONE) {
    anchor = top;
    showBars();
    return;
  }

  const delta = top - anchor;
  if (Math.abs(delta) < STEP) return;
  anchor = top;
  if (delta > 0) hideBars();
  else showBars();
}

export function installAutoHideBars(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // 捕获阶段：scroll 不冒泡，元素上的滚动只能在捕获阶段拿到
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // 键盘一弹、输入框一聚焦，顶栏就得回来 —— 否则编辑区顶部被盖住，点不到
  window.addEventListener(
    'focusin',
    () => {
      if (root().dataset.touch === '1') showBars();
    },
    true,
  );
}
