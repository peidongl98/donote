/**
 * 后台两件事：空闲预拉取、dirty 回推。
 *
 * 预拉取 —— 用户停手 30 秒后，慢慢把没缓存过的笔记正文拉下来，
 * 让「断网时能看的」一点点变多。一轮 6 篇、篇间隔 2.5 秒；撞上限流
 * （503 / 429）就停 10 分钟，不跟服务端对着干。一轮什么都没拉到
 * （说明都缓存过了）就把下次检查推到 10 分钟后，免得空转着刷目录。
 *
 * 回推 —— 断网时标了 dirty 的笔记，恢复联网后按 mtime 比较：
 * 本地更新就推上去；云端更新就报冲突，交给用户决定留哪边。
 */
import { StorageError } from '@/services/storage';
import type { CachedStorage } from './cached-adapter';

/** 多久没操作算空闲 */
const IDLE_MS = 30_000;
/** 一轮拉几篇 */
const BATCH = 6;
/** 篇与篇之间的间隔 */
const GAP_MS = 2_500;
/** 被限流后停多久 */
const COOLDOWN_MS = 10 * 60_000;
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

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof StorageError && (error.status === 503 || error.status === 429)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackgroundWork {
  private lastActivity = Date.now();
  private nextAllowed = 0;
  private cooldownUntil = 0;
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
      Date.now() < this.cooldownUntil ||
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
      } catch (error) {
        if (isRateLimited(error)) {
          this.cooldownUntil = Date.now() + COOLDOWN_MS;
          return true;
        }
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
        if (isRateLimited(error)) {
          this.cooldownUntil = Date.now() + COOLDOWN_MS;
          return worked;
        }
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
      } catch (error) {
        if (isRateLimited(error)) {
          this.cooldownUntil = Date.now() + COOLDOWN_MS;
          return worked;
        }
        return worked;
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
