/**
 * 全局请求闸门 —— 所有出站 DAV 请求都从这里取票。
 *
 * 为什么需要：DoNote 有五处各自独立的请求源（建树 `walkTree` / 回收站 `listTrash` /
 * 后台校验队列 / 空闲预拉取 / dirty 回推），每个自己限速、互不知情，瞬时并发最高可叠加到 10。
 * 而坚果云免费版额度是 **600 次 / 30 分钟 ≈ 每 3 秒 1 个请求**，并发叠加必然撞 503；
 * 同类应用（Joplin / Obsidian Remotely Save / rclone）在坚果云上的结论一致：**并发压到 1**。
 *
 * 限速用**令牌桶**，而不是「每个请求之间固定隔 3.2 秒」：
 *   · **突发额度 BURST = 30**：首次连上要一口气建树，一个目录一次 PROPFIND ——
 *     26 个目录就是 26 次请求。固定间隔会把它拖成 **26 × 3.2 ≈ 85 秒**，用户看到的就是「打不开」；
 *     有了桶，这 26 次走库存、几秒内跑完。
 *   · **补票速率 1 / 3.2 秒**：长期速率仍是 600 次 / 30 分钟。桶空之后每个请求就自然落回
 *     「一个 3.2 秒」，需要慢的场景（后台校验、预拉取）照样慢。
 *   · 容量 30 是**按同一个额度窗口倒推**的：30（突发）+ 562（30 分钟内按 3.2 秒补出来的）≈ 592 < 600。
 *     再放大就会透支额度，所以这条上限不能随手改。
 * gapMs 由调用方给（见 storage/transport.ts）：dev 下传 0 → 只保证串行、不取票（回归套件不被人为拖慢）。
 */

/** 补票间隔：坚果云 600 次 / 30 分钟 = 0.333 次/秒 → 取 3.2 秒留 6% 余量 */
export const REMOTE_MIN_GAP_MS = 3_200;
/** 突发额度：必须与补票速率一起塞得进同一个 30 分钟窗口（30 + 562 ≈ 592 < 600） */
export const BURST_TOKENS = 30;
/** 额度窗口与上限（坚果云免费版；可观测用） */
export const BUDGET_WINDOW_MS = 30 * 60_000;
export const BUDGET_LIMIT = 600;

/** 桶里的票数；空闲时补满 */
let tokens = BURST_TOKENS;
let lastRefill = 0;
/** 队列链：每个请求接在上一个之后，保证同一时刻只有一个在途 */
let chain: Promise<unknown> = Promise.resolve();
/** 窗口内的放行时刻，用于「最近 30 分钟已用多少」（只留窗口内的） */
const recent: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prune(): void {
  const edge = Date.now() - BUDGET_WINDOW_MS;
  while (recent.length && recent[0] < edge) recent.shift();
}

/**
 * 取一张票；取不到就返回要等多久（毫秒）。
 *
 * 等完之后票正好补够 1 张、并且已经用掉，所以把 lastRefill 推到「等待结束那一刻」、
 * 票数归零 —— 于是桶空之后就是精确的「一个 3.2 秒一个」，不会越等越偏。
 */
function takeToken(gapMs: number): number {
  const now = Date.now();
  if (now > lastRefill) {
    tokens = Math.min(BURST_TOKENS, tokens + (now - lastRefill) / gapMs);
    lastRefill = now;
  }
  if (tokens >= 1) {
    tokens -= 1;
    return 0;
  }
  const wait = (1 - tokens) * gapMs;
  tokens = 0;
  lastRefill = now + wait;
  return wait;
}

/**
 * 取票执行一次请求。gapMs 为 0 时只保证并发 1、不取票。
 * 前一个请求失败不应影响后面的请求 —— 链上挂了 catch，单独返回原始的 run 给调用方。
 */
export function throughGate<T>(gapMs: number, task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    if (gapMs > 0) {
      const wait = takeToken(gapMs);
      if (wait > 0) await sleep(wait);
    }
    recent.push(Date.now());
    prune();
    return task();
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 最近 30 分钟用掉的请求数（设置页展示用） */
export function requestBudget(): { used: number; limit: number; windowMs: number } {
  prune();
  return { used: recent.length, limit: BUDGET_LIMIT, windowMs: BUDGET_WINDOW_MS };
}
