/**
 * WebDAV 请求的传输层。
 *
 * 各端的网络能力不同，统一在这里收口，上层代码不关心请求最终怎么发出去：
 *
 *  - 浏览器 / dev：window.fetch。dev 环境只有坚果云配了 Vite 代理
 *    （/nutdav → dav.jianguoyun.com），因为多数 WebDAV 服务不返回 CORS 响应头，
 *    浏览器直连必被拦；换别的服务器时 dev 下直连失败属预期。
 *  - Tauri（Windows / iOS）：tauri-plugin-http 的 fetch，走 Rust reqwest，
 *    不经浏览器，天然不受 CORS 约束（见 storage/tauri.ts）。
 *  - 鸿蒙：换成壳里 javaScriptProxy 注入的原生桥（@ohos.net.http）。
 */
export type DavFetch = (url: string, init: RequestInit) => Promise<Response>;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let impl: DavFetch = (url, init) => fetch(url, init);

export function setDavFetch(next: DavFetch): void {
  impl = next;
}

export function davFetch(url: string, init: RequestInit): Promise<Response> {
  return impl(url, init);
}
