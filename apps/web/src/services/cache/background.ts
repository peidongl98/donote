/**
 * 后台两件事：空闲预拉取、dirty 回推。
 *
 * 预拉取 —— 用户停手 30 秒后，慢慢把没缓存过的笔记正文拉下来，
 * 让「断网时能看的」一点点变多。一轮 2 篇；撞上限流（503 / 429）就停手，
 * 退避档位由出网层统一记（见 storage/backoff.ts），这里不自己算冷却时间。
 * 一轮什么都没拉到（说明都缓存过了）就把下次检查推到 10 分钟后，免得空转着刷目录。
 *
 * 回推 —— 断网时标了 dirty 的笔记，恢复联网后按 mtime 比较：
 * 本地更新就推上去；云端更新就报冲突，交给用户决定留哪边。
 */
import { StorageError } from '@/services/storage';
import { inBackoff } from '@/storage/backoff';
import type { CachedStorage } from './cached-adapter';

/** 多久没操作算空闲 */
const IDLE_MS = 30_000;
/**
 * 一轮拉几篇。
 *
 * 曾经是 6：大库上每轮 6 篇正文就是几百次 GET，占满整个 30 分钟额度，
 * 而换来的收益只是「断网时能多看的几篇」—— 用户感知不到，额度却实实在在烧掉了。
 * 闸门限速之后单篇成本更高（每篇至少隔 3.2 秒），所以降到 2。
 */
const BATCH = 2;
/** 篇与篇之间的间隔 */
const GAP_MS = 2_500;
/** 一轮无事可做后，隔多久再看一眼 */
const IDLE_EMPTY_MS = 10 * 60_000;
/** 调度心跳 */
const TICK_MS = 5_000;

export interface BackgroundDeps {
  /** 同步根下所有笔记的相对路径 */
  listNotes(): Promise<string[]>;
  /** 发现冲突（云端比本地新）时回调 */
  onConflict(path: string, localMtime: number, remoteMtime: number): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackgroundWork {
  private lastActivity = Date.now();
  private nextAllowed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private cache: CachedStorage,
    private deps: BackgroundDeps,
  ) {}

  start(): void {
    if (this.timer || typeof window === 'undefined') return;
    const touch = () => {
      this.lastActivity = Date.now();
    };
    for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
      window.addEventListener(type, touch, { passive: true });
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 用户刚操作过（例如刚存完一篇），把空闲计时清零 */
  touch(): void {
    this.lastActivity = Date.now();
  }

  private busyNow(): boolean {
    return (
      this.busy ||
      this.stopped ||
      inBackoff() ||
      Date.now() < this.nextAllowed ||
      Date.now() - this.lastActivity < IDLE_MS ||
      this.cache.isOffline()
    );
  }

  private async tick(): Promise<void> {
    if (this.busyNow()) return;
    this.busy = true;
    try {
      const pushed = await this.flushDirty();
      const pulled = await this.prefetchRound();
      // 这一轮干了活就早点再来，没事做就歇久一点
      this.nextAllowed = Date.now() + (pushed || pulled ? IDLE_MS : IDLE_EMPTY_MS);
    } catch {
      this.nextAllowed = Date.now() + IDLE_EMPTY_MS;
    } finally {
      this.busy = false;
    }
  }

  /* ------------------------------ 预拉取 ------------------------------ */

  private async prefetchRound(): Promise<boolean> {
    const all = await this.deps.listNotes();
    const todo = all.filter((path) => !this.cache.hasCopy(path)).slice(0, BATCH);
    if (!todo.length) return false;

    for (const path of todo) {
      try {
        // 不走 preferCache：这里要的就是把云端正文拉下来落进副本
        await this.cache.read(path);
      } catch {
        // 撞限流就停手。退避档位由出网层记，下一轮 busyNow 会读到，这里不自己算
        if (inBackoff()) return true;
      }
      await sleep(GAP_MS);
    }
    return true;
  }

  /* ------------------------------ dirty 回推 ------------------------------ */

  private async flushDirty(): Promise<boolean> {
    const pending = Object.entries(this.cache.noteRows()).filter(([, row]) => row.dirty);
    if (!pending.length) return false;

    let worked = false;
    for (const [path, row] of pending) {
      let remoteMtime: number | null = null;
      try {
        remoteMtime = (await this.cache.stat(path)).mtime;
      } catch (error) {
        if (inBackoff()) return worked;
        if (error instanceof StorageError && error.code === 'not_found') {
          remoteMtime = null; // 云端没有这篇，直接推
        } else {
          return worked; // 还是连不上，等下一轮
        }
      }

      if (remoteMtime !== null && remoteMtime > row.mtime) {
        this.deps.onConflict(path, row.mtime, remoteMtime);
        worked = true;
        continue;
      }

      const body = await this.cache.localCopy(path);
      if (body === null) continue;
      try {
        await this.cache.write(path, body); // 成功会自动把 dirty 清掉
        worked = true;
      } catch {
        return worked; // 推不上去就等下一轮（限流的话 busyNow 会拦住）
      }
    }
    return worked;
  }

  /** 手动触发一次（设置页的「立即同步」用）。顺手把校验时间作废，下一轮重新对账整棵树 */
  async runNow(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.cache.invalidateChecks();
      await this.flushDirty();
      await this.prefetchRound();
    } finally {
      this.busy = false;
    }
  }
}
