/**
 * 长按进入多选。
 *
 * 鼠标与触屏用**同一套规则**（按住 500ms），不再按 `hover` 媒体查询分两条路 ——
 * 条件少一层，桌面端按住不动就进多选也不违反直觉，而且能一条断言测到底。
 *
 * 抬手之后浏览器还会补一个 `click`，移动端还会补一个 `contextmenu`；
 * 两者都要用 `consume()` / `recent()` 吞掉，否则会顺着 RouterLink 跳进详情、
 * 或者同时弹出单条菜单。
 */
import { onBeforeUnmount } from 'vue';

/** 判定为「刚长按过」的窗口，够盖住 click 与 contextmenu 的补发 */
const RECENT_MS = 700;

export function useLongPress(onTrigger: () => void, ms = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firedAt = 0;
  let startX = 0;
  let startY = 0;

  function cancel(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function start(event: PointerEvent): void {
    // 卡片上的按钮（勾选框 / ⋯ / 恢复 / 彻底删除）自己有事要做，不参与长按
    if ((event.target as HTMLElement | null)?.closest('button')) return;
    firedAt = 0;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      firedAt = Date.now();
      onTrigger();
    }, ms);
  }

  function move(event: PointerEvent): void {
    if (!timer) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) cancel();
  }

  /** 最近刚长按过？（不消费，给 contextmenu 这类要判两次的地方用） */
  function recent(): boolean {
    return firedAt > 0 && Date.now() - firedAt < RECENT_MS;
  }

  /** 长按是不是刚触发过；取一次就复位 */
  function consume(): boolean {
    const was = recent();
    firedAt = 0;
    return was;
  }

  onBeforeUnmount(cancel);

  return { start, cancel, move, recent, consume };
}
