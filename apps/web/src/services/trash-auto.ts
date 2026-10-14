/**
 * 回收站自动清理：设置项 + 触发点。
 *
 * 不做定时任务 —— 只在两个时刻查一次：应用启动（侧栏出现时）、打开回收站时。
 * 设置存 localStorage：和主题、侧栏折叠一样是本机偏好，不写进用户网盘。
 *
 * 真正动手的是数据层的 `purgeExpiredTrash(days)`：按**顶层条目**的 deletedAt 算，
 * 到期整条一起清；被网盘限流（503）就停下，下次触发接着清，不当成错误报给用户。
 */
import { purgeExpiredTrash } from '@/storage/notes';

const KEY = 'donote.trash.auto.v1';

export const TRASH_DAYS_MIN = 1;
export const TRASH_DAYS_MAX = 30;
const DEFAULT_DAYS = 30;

export interface TrashAutoSetting {
  enabled: boolean;
  /** 保留天数（1–30） */
  days: number;
  /** 上次检查的时刻（0 = 还没跑过） */
  checkedAt: number;
}

export function clampDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(TRASH_DAYS_MAX, Math.max(TRASH_DAYS_MIN, Math.round(value)));
}

export function readTrashAuto(): TrashAutoSetting {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<TrashAutoSetting>;
    return {
      enabled: raw.enabled !== false,
      days: clampDays(raw.days ?? DEFAULT_DAYS),
      checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : 0,
    };
  } catch {
    return { enabled: true, days: DEFAULT_DAYS, checkedAt: 0 };
  }
}

export function writeTrashAuto(patch: Partial<TrashAutoSetting>): TrashAutoSetting {
  const next = { ...readTrashAuto(), ...patch };
  if (patch.days !== undefined) next.days = clampDays(next.days);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 无痕模式写不进去：当次会话内用这个返回值，不打断用户
  }
  return next;
}

/**
 * 启动与「打开回收站」会挨着触发，同一个会话里 60 秒内只真跑一次。
 *
 * 正在跑的那次**共用同一个 promise**：打开应用就直接落在回收站页时，两个触发点几乎同时
 * 到达，如果第二次直接返回 0，回收站列表就会在清理还没落地时先列一遍，把刚清掉的条目
 * 显示出来。让它等同一个 promise，列表就一定排在清理之后。
 */
const THROTTLE = 60_000;
let pending: Promise<number> | null = null;
let lastDone = 0;

/**
 * 跑一次检查。返回清掉了几条。
 * 任何失败都吞掉 —— 自动清理是后台行为，不该给用户弹错误。
 */
export async function runTrashAutoClean(): Promise<number> {
  if (pending) return pending;
  if (Date.now() - lastDone < THROTTLE) return 0;
  const setting = readTrashAuto();
  if (!setting.enabled) return 0;

  pending = (async () => {
    try {
      const removed = await purgeExpiredTrash(setting.days);
      writeTrashAuto({ checkedAt: Date.now() });
      return removed;
    } catch {
      return 0;
    } finally {
      lastDone = Date.now();
      pending = null;
    }
  })();
  return pending;
}
