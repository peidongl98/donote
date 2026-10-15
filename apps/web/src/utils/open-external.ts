import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauriRuntime } from '../storage/transport';

/**
 * 用系统默认浏览器打开一个外部链接。
 *
 * 为什么要自己实现 —— Tauri 的 WebView2 里，`<a href="https://…" target="_blank">`
 * 点下去**什么都不会发生**：既不调起系统浏览器，也不开新窗口（Tauri 没有默认的
 * 新窗口处理器，只是把这次导航丢弃）。桌面端必须显式请求系统的打开动作。
 *
 * 浏览器里退回 window.open；它在同步路径上调用，不会被弹窗拦截器当成广告窗口。
 *
 * 插件用**静态 import**：动态 import 在打包产物里是单独一个 chunk，
 * 加载失败时只会变成一个静默的 rejected promise（不报错也不执行），
 * 真机实测就卡在这一步。静态引入没有这个中间环节，代价只有约 1KB。
 */
export async function openExternal(url: string): Promise<void> {
  if (!isExternal(url)) return;

  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 只认 http/https 的跨源地址；同源链接与页内锚点交给应用自己的路由 */
export function isExternal(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * 全应用统一接管外链点击。
 *
 * 用事件委托而不是逐个改组件：一处安装，所有 `<a href="https://…">` 都生效，
 * 之后新加的外链也不会重演「点了没反应」。挂在 document 上，动态渲染出来的链接
 * 同样覆盖到；`e.defaultPrevented` 让组件自己拦掉的点击优先。
 */
export function installExternalLinks(): void {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const target = e.target as Element | null;
    const anchor = target?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;

    const href = anchor.getAttribute('href') ?? '';
    if (!isExternal(href)) return;

    e.preventDefault();
    void openExternal(href);
  });
}
