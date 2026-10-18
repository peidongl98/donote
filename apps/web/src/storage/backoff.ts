/**
 * 限流退避 —— 所有请求源**共用一个状态**（用的是同一个账号的额度）。
 *
 * 原来的两处冷却各自为政、且都比服务端的实际封锁短得多：
 *   后台校验 5 分钟、预拉取 10 分钟，而坚果云撞 503 后官方建议**停 6 小时**。
 * 差了 36–72 倍 → 撞上之后每次重试都在给「下一次封锁」续期，于是 503 会一直持续
 * （2026-10-16 真机实测正是如此）。
 *
 * 规则（与 Joplin / Remotely Save 同款）：
 *   - 撞 503 / 429 → 30 分钟起，每次再撞**翻倍**：30 → 60 → 120 → 240 → 360（封顶 6 小时）；
 *   - 加 **±25% 随机抖动**，多端 / 多请求源不会同时重试；
 *   - 响应带 `Retry-After` 时**用它覆盖**本地算出的值；
 *   - 任一请求成功 → 档位复位回 30 分钟。
 */

const BASE_MS = 30 * 60_000;
const MAX_MS = 6 * 60 * 60_000;
const JITTER = 0.25;

/** 已经连续撞了几次（决定翻倍到第几档） */
let streak = 0;
let until = 0;

/** 退避到什么时候为止（0 表示没在退避） */
export function backoffUntil(): number {
  return until;
}

/** 现在是否处于退避期 —— 各请求源发起前先问一句，别往枪口上撞 */
export function inBackoff(): boolean {
  return Date.now() < until;
}

/**
 * 撞上限流。`retryAfterSeconds` 来自响应头 `Retry-After`，给了就以它为准。
 * 返回本次退避的截止时刻。
 */
export function hitRateLimit(retryAfterSeconds?: number): number {
  streak += 1;
  const base =
    retryAfterSeconds && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(BASE_MS * 2 ** (streak - 1), MAX_MS);
  const jittered = base * (1 + (Math.random() * 2 - 1) * JITTER);
  until = Date.now() + jittered;
  return until;
}

/** 一次成功 → 复位。没在退避时不做任何事 */
export function clearBackoff(): void {
  if (streak === 0 && until === 0) return;
  streak = 0;
  until = 0;
}

/**
 * 让退避**立刻结束**（不动翻倍档位）。
 *
 * 「时间到了」这一天本来会自然发生，但代码里没有别的地方能把它提前 —— 于是：
 *   · 回归没法测「退避走完 + 一次成功 → 复位」这条链路（只能干等 30 分钟）；
 *   · 界面上也没法给「现在就重试一次」留后路。
 * 只改截止时刻，不改 streak：再撞一次仍然是原来的档位，不会因为按过一次就放宽。
 */
export function expireBackoff(): void {
  if (until === 0) return;
  until = Date.now();
}

/** 当前档位（日志 / 诊断用） */
export function backoffStreak(): number {
  return streak;
}
