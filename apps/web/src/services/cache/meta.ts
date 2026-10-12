/**
 * 缓存元数据。两份文件，都在缓存根下：
 *
 *   meta.json     笔记索引：路径 → 标题 / 所在文件夹 / mtime / etag / 是否已缓存 / 是否有待推改动
 *   folders.json  文件夹结构：目录路径数组 + 已经列过的目录路径数组
 *
 * 设计取舍：元数据是「全量」的，笔记正文是「按需」的。
 * 列一次目录就能把 meta 写全，正文只在本机读过才落盘 —— 缓存目录不会因此膨胀。
 * 正文在 `notes/<相对路径>` 下原样保留目录层级，用户在资源管理器里能直接看懂。
 *
 * `listed`（已经列过的目录）只用于一件事：判断「这一层列回来的结果」可不可以拿来
 * 删本地索引里多出来的条目。没列过的目录不做删除判定，免得一次不完整的响应把索引清空。
 */
import type { CacheStore } from './store';

const META_FILE = 'meta.json';
const FOLDERS_FILE = 'folders.json';
const META_VERSION = 1;

/** folders.json 的形状。旧版本只写了 items，读的时候按缺省处理。 */
export interface FoldersFile {
  items: string[];
  listed: string[];
  /** 目录 → 上次校验完成的时刻。跨进程保留：重开应用不必立刻把整棵树重查一遍 */
  checked: Record<string, number>;
}

/** 只保留最近校验过的目录，免得这份文件随目录增删无限长大 */
const CHECKED_KEEP_MS = 10 * 60_000;

/** 正文落盘的位置：`工作/周报.md` → `notes/工作/周报.md` */
export function noteFile(rel: string): string {
  return `notes/${rel}`;
}

export interface NoteRow {
  title: string;
  /** 所在文件夹的相对路径，根目录为空串 */
  folder: string;
  mtime: number;
  etag: string;
  /** 正文已经落到 notes/ 下 */
  cached: boolean;
  /** 有本地改动还没推上云 */
  dirty: boolean;
}

export interface CacheMeta {
  version: number;
  /** 建这份缓存时的同步根。换了网盘目录就整份作废 */
  root: string;
  updatedAt: number;
  notes: Record<string, NoteRow>;
}

export function emptyMeta(root: string): CacheMeta {
  return { version: META_VERSION, root, updatedAt: 0, notes: {} };
}

/** 读 meta。文件缺失、损坏、版本对不上、或同步根换了，一律当作「没有缓存」。 */
export async function loadMeta(store: CacheStore, root: string): Promise<CacheMeta> {
  try {
    const raw = await store.read(META_FILE);
    if (!raw) return emptyMeta(root);
    const parsed = JSON.parse(raw) as Partial<CacheMeta>;
    if (parsed.version !== META_VERSION || parsed.root !== root || !parsed.notes) {
      return emptyMeta(root);
    }
    return {
      version: META_VERSION,
      root,
      updatedAt: parsed.updatedAt ?? 0,
      notes: parsed.notes,
    };
  } catch {
    return emptyMeta(root);
  }
}

export async function saveMeta(store: CacheStore, meta: CacheMeta): Promise<void> {
  try {
    await store.write(META_FILE, JSON.stringify({ ...meta, updatedAt: Date.now() }));
  } catch {
    // 缓存写不进去不该影响正常读写笔记
  }
}

export async function loadFolders(store: CacheStore): Promise<FoldersFile> {
  try {
    const raw = await store.read(FOLDERS_FILE);
    if (!raw) return { items: [], listed: [], checked: {} };
    const parsed = JSON.parse(raw) as { items?: unknown; listed?: unknown; checked?: unknown };
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    const checked: Record<string, number> = {};
    if (parsed.checked && typeof parsed.checked === 'object') {
      for (const [dir, at] of Object.entries(parsed.checked as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at)) checked[dir] = at;
      }
    }
    return { items: strings(parsed.items), listed: strings(parsed.listed), checked };
  } catch {
    return { items: [], listed: [], checked: {} };
  }
}

export async function saveFolders(
  store: CacheStore,
  items: string[],
  listed: string[],
  checked: Map<string, number>,
): Promise<void> {
  try {
    const keep: Record<string, number> = {};
    const floor = Date.now() - CHECKED_KEEP_MS;
    for (const [dir, at] of checked) if (at >= floor) keep[dir] = at;
    await store.write(FOLDERS_FILE, JSON.stringify({ items, listed, checked: keep }, null, 0));
  } catch {
    // 同上
  }
}
