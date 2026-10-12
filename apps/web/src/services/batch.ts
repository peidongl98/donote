/**
 * 批量执行。
 *
 * 串行 + 固定间隔是刻意的：坚果云免费版是 600 请求 / 30 分钟，
 * 并发打只会更快撞上 503（`BlockedTemporarily`，一封约 20 分钟）。
 * 宁可慢一点，也别把用户锁在「连不上」二十分钟里。
 */
import { StorageError } from '@/services/storage';

export interface BatchFailure {
  id: string;
  message: string;
}

export interface BatchResult {
  total: number;
  /** 成功条数 */
  ok: number;
  failed: BatchFailure[];
  /** 因限流中断、压根没轮到跑的 */
  aborted: string[];
}

export interface BatchOptions {
  /** 两步之间的间隔，默认 400ms */
  intervalMs?: number;
  /** 每处理完一条回调一次，用来在工具栏上写「正在删除 3/10」 */
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 503 = 被限流。继续打只会把封锁时间拖长，必须立刻停 */
function throttled(error: unknown): boolean {
  return error instanceof StorageError && error.status === 503;
}

function reasonOf(error: unknown): string {
  if (error instanceof StorageError) return error.message;
  return error instanceof Error ? error.message : '执行失败';
}

export async function batchExecute(
  items: string[],
  operation: (id: string) => Promise<unknown>,
  { intervalMs = 400, onProgress }: BatchOptions = {},
): Promise<BatchResult> {
  const failed: BatchFailure[] = [];
  let ok = 0;

  for (let i = 0; i < items.length; i++) {
    const id = items[i];
    try {
      await operation(id);
      ok++;
    } catch (error) {
      if (throttled(error)) {
        return { total: items.length, ok, failed, aborted: items.slice(i) };
      }
      failed.push({ id, message: reasonOf(error) });
    }
    onProgress?.(i + 1, items.length);
    if (i < items.length - 1) await sleep(intervalMs);
  }

  return { total: items.length, ok, failed, aborted: [] };
}

/**
 * 一行汇总，给 toast 用。
 * 刻意只报数、不带原因 —— `.toast` 是 `nowrap + ellipsis`，
 * 长句子会被截掉，原因留给工具栏那一条能换行的提示去说。
 */
export function summarize(result: BatchResult, verb: string): string {
  if (result.aborted.length) {
    return `网盘限流，已中断：成功 ${result.ok} 项，剩 ${result.aborted.length} 项`;
  }
  if (result.failed.length) return `成功 ${result.ok} / 失败 ${result.failed.length}`;
  return `已${verb} ${result.total} 项`;
}
