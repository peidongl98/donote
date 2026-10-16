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
import { clearBackoff, hitRateLimit } from './backoff';
import { REMOTE_MIN_GAP_MS, throughGate } from './gate';

export type DavFetch = (url: string, init: RequestInit) => Promise<Response>;

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 限速只在**正式构建**里生效，dev 下一律不限速。
 *
 * 为什么不在 dev 里也限：dev 下从地址上分不出「真坚果云」和「回归用的假 DAV」——
 * 两者都走 Vite 的 `/nutdav` 同源代理，URL 一模一样。而 dev 里既不会有几百篇的真实笔记库，
 * 也不该把 9 套回归拖成几倍时长，所以直接按构建模式一刀切。
 * 用户装的那份是正式构建 → 所有请求都是真服务器，全部按间隔走。
 */
const MIN_GAP_MS = import.meta.env.DEV ? 0 : REMOTE_MIN_GAP_MS;

let impl: DavFetch = (url, init) => fetch(url, init);

export function setDavFetch(next: DavFetch): void {
  impl = next;
}

/** 响应头里的 Retry-After（秒）。读不到就返回 0，退避按本地档位算 */
function retryAfterOf(res: Response): number {
  try {
    const secs = Number(res.headers.get('retry-after'));
    return Number.isFinite(secs) && secs > 0 ? secs : 0;
  } catch {
    return 0;
  }
}

/**
 * 出网唯一出口 —— 全应用所有 WebDAV 请求都在这里收口，所以两件事都挂在这一层：
 *
 *   1. **全局闸门**（串行 + 最小间隔），见 storage/gate.ts；
 *   2. **限流退避的记账**（撞 503/429 进档、成功复位），见 storage/backoff.ts。
 *
 * 退避记在这里而不是各消费方：状态只有一份（同一个账号的额度），而这一层能直接看到
 * 每个响应的状态码与 `Retry-After`，各消费方只需要在发起前问一句 `inBackoff()`。
 *
 * 不在每个调用点各加一个 sleep：那样「建树 / 回收站 / 后台校验 / 预拉取 / dirty 回推」
 * 五个源还是会各自为政（见 docs/sync-concurrency-plan.md §4）。
 */
export async function davFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await throughGate(MIN_GAP_MS, () => impl(url, init));
  if (res.status === 503 || res.status === 429) hitRateLimit(retryAfterOf(res));
  else clearBackoff();
  return res;
}
