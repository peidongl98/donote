/**
 * 笔记数据层：一切读写都落到用户自己的网盘，本地不存数据库。
 *
 * 文件模型
 *   <同步根>/<文件夹…>/<标题>.md   一篇笔记 = 一个 .md 文件
 *   <同步根>/.trash/<时间>-<随机>-<标题>.md   删除先进回收站，frontmatter 记原路径
 *   文件夹 = 真目录；以 `.` 开头的目录（含 .trash）不参与展示
 *
 * 网络请求全部交给 services/storage 的适配器，这里只做业务：
 * 路径与命名规则、目录遍历与缓存、DTO 组装、搜索。
 *
 * 对外暴露的 DTO 形状与之前走 HTTP 时完全一致，视图层不用改。
 * 笔记/文件夹的 id = 相对路径的 base64url（路径含 `/`，直接塞进路由会破坏匹配）。
 */

import {
  NOTE_LIMITS,
  type FolderDTO,
  type NoteDTO,
  type NoteListResult,
  type NoteSummaryDTO,
} from '@donote/shared';
import { getStorage, StorageError, type DirEntry } from '@/services/storage';
import {
  assetsDirName,
  getAssetsDirPath,
  isAssetsDir,
  pathExists,
  rewriteAssetRefs,
  uniqueName,
} from '@/services/attachments';
import { excerptOf, parseNote, serializeNote, type NoteMeta } from './frontmatter';

/** 视图层一直用的是这个名字，这里保持导出，避免无谓的改动面 */
export { StorageError as DavError };

/* ------------------------------ 路径工具 ------------------------------ */

/** 只做 base64url：结果里不含 `/`、`+`、`=`，可以安全地当路由参数 */
export function encodeId(rel: string): string {
  const bytes = new TextEncoder().encode(rel);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeId(id: string): string {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parentOf(rel: string): string {
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : rel.slice(0, at);
}

/** 去掉扩展名后的末段，即默认标题 */
function baseName(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

function stemOf(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/** 文件名里不能出现的字符换掉；给用户看的标题不受影响 */
function sanitize(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return cleaned || '未命名';
}

/* ------------------------------ 适配器包装 ------------------------------ */

/** 列目录。适配器返回的 mtime 是可选的，这里补齐成数字，后续不用到处判空 */
async function listDir(rel: string): Promise<DirEntry[]> {
  const entries = await getStorage().list(rel);
  return entries.map((entry) => ({ ...entry, mtime: entry.mtime ?? 0 }));
}

/** 读文本。把「不存在」翻译成 null，其余错误照旧抛出 */
async function readOrNull(rel: string): Promise<string | null> {
  try {
    return await getStorage().read(rel);
  } catch (error) {
    if (error instanceof StorageError && error.code === 'not_found') return null;
    throw error;
  }
}

/* ------------------------------ 目录树 ------------------------------ */

interface Tree {
  notes: DirEntry[];
  dirs: DirEntry[];
}

const MAX_DIRS = 300;
const MAX_DEPTH = 8;

/** 广度优先递归；同层并发 4，避免一条条串行把加载拖到十几秒 */
async function walkTree(): Promise<Tree> {
  const acc: Tree = { notes: [], dirs: [] };
  let frontier: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  let visited = 0;

  while (frontier.length && visited < MAX_DIRS) {
    const group = frontier.splice(0, 4);
    const results = await Promise.all(
      group.map((item) => listDir(item.rel).catch(() => [] as DirEntry[])),
    );
    const next: { rel: string; depth: number }[] = [];

    results.forEach((entries, index) => {
      visited++;
      const depth = group[index].depth;
      for (const entry of entries) {
        // 点开头的是内部目录（.trash 等）；`.assets` 是笔记的附件目录。
        // 两者都不是笔记，也不往下递归 —— .assets 内部约定平铺。
        if (entry.name.startsWith('.') || isAssetsDir(entry.name)) continue;
        if (entry.isDirectory) {
          acc.dirs.push(entry);
          if (depth + 1 < MAX_DEPTH) next.push({ rel: entry.path, depth: depth + 1 });
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          acc.notes.push(entry);
        }
      }
    });

    frontier = next;
  }
  return acc;
}

/** 一次页面加载会同时要列表和文件夹，这里合并成一次遍历 */
let treeCache: { at: number; data: Tree } | null = null;

function invalidateTree(): void {
  treeCache = null;
}

async function tree(force = false): Promise<Tree> {
  if (!force && treeCache && Date.now() - treeCache.at < 3000) return treeCache.data;
  const data = await walkTree();
  treeCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------ 摘要缓存 ------------------------------ */

/**
 * 列表要显示摘要，而 WebDAV 列目录不含正文。
 * 于是把读过的笔记摘要按路径+mtime 缓存在本地：首次打开会慢慢补齐，之后加载几乎零请求。
 */
const CACHE_KEY = 'donote.excerpts.v1';
const HYDRATE_BATCH = 40;

interface CacheRow {
  m: number;
  e: string;
}

let excerptCache: Record<string, CacheRow> | null = null;

function cache(): Record<string, CacheRow> {
  if (excerptCache) return excerptCache;
  try {
    excerptCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, CacheRow>;
  } catch {
    excerptCache = {};
  }
  return excerptCache;
}

function persistCache(): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache()));
  } catch {
    // 配额满了就丢掉缓存，不影响主流程
  }
}

function cachedExcerpt(entry: DirEntry): string {
  const row = cache()[entry.path];
  return row && row.m === entry.mtime ? row.e : '';
}

/** 并发受限的 map，避免一次甩出上百个请求被服务端限流 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/** 后台补齐摘要。返回本次真正读回了几篇，供视图决定要不要刷一次列表 */
export async function hydrateExcerpts(limit = HYDRATE_BATCH): Promise<number> {
  const { notes } = await tree();
  const filled = cache();
  const pending = notes
    .filter((entry) => !filled[entry.path] || filled[entry.path].m !== entry.mtime)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, limit);
  if (!pending.length) return 0;

  let done = 0;
  await mapLimited(pending, 2, async (entry) => {
    try {
      const raw = await readOrNull(entry.path);
      if (raw === null) return;
      filled[entry.path] = {
        m: entry.mtime ?? 0,
        e: excerptOf(parseNote(raw, entry.name, entry.mtime ?? 0).body),
      };
      done++;
    } catch {
      // 单篇读失败不该拖垮整次补齐
    }
  });
  if (done) persistCache();
  return done;
}

/* ------------------------------ 组装 DTO ------------------------------ */

function summaryOf(entry: DirEntry): NoteSummaryDTO {
  const folder = parentOf(entry.path);
  return {
    id: encodeId(entry.path),
    folder_id: folder ? encodeId(folder) : null,
    title: baseName(entry.path),
    excerpt: cachedExcerpt(entry),
    created_at: entry.mtime ?? 0,
    updated_at: entry.mtime ?? 0,
    deleted_at: null,
  };
}

function noteOf(rel: string, meta: NoteMeta, body: string): NoteDTO {
  const folder = parentOf(rel);
  return {
    id: encodeId(rel),
    folder_id: folder ? encodeId(folder) : null,
    title: meta.title,
    content: body,
    created_at: meta.created,
    updated_at: meta.updated,
    deleted_at: meta.deleted_at ?? null,
    version: 1,
  };
}

/** 目标目录下挑一个没被占用的文件名 */
async function uniqueRel(dir: string, stem: string, ext: string, exclude?: string): Promise<string> {
  const entries = await listDir(dir);
  const taken = new Set(
    entries.filter((entry) => entry.path !== exclude).map((entry) => entry.name),
  );
  let candidate = `${stem}${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${stem} ${n}${ext}`;
    n++;
  }
  return dir ? `${dir}/${candidate}` : candidate;
}

/* ------------------------------ 附件联动 ------------------------------ */

/**
 * 回收站里的条目名是 `${时间戳}-${随机}-${原名}.md`，
 * 附件目录沿用同一前缀 —— 配对靠这个前缀，不靠 frontmatter。
 */
function trashAssetsPath(trashRel: string): string {
  return `${trashRel.replace(/\.md$/i, '')}.assets`;
}

/**
 * 把附件目录搬到新位置。
 * 目标已存在就不覆盖：把源目录里的文件逐个挪过去，重名加后缀，最后删掉空壳。
 */
async function moveAssets(fromDir: string, toDir: string): Promise<void> {
  if (!(await pathExists(fromDir))) return;
  if (!(await pathExists(toDir))) {
    await getStorage().move(fromDir, toDir);
    return;
  }
  const taken = new Set((await listDir(toDir)).map((entry) => entry.name));
  for (const entry of await listDir(fromDir)) {
    const name = uniqueName(entry.name, taken);
    taken.add(name);
    await getStorage().move(entry.path, `${toDir}/${name}`);
  }
  await getStorage().delete(fromDir);
}

/* ------------------------------ 笔记 API ------------------------------ */

export interface NoteListQuery {
  /** 省略 = 全部；'root' 或空 = 未归类；其它 = 文件夹 id（含其子文件夹） */
  folder_id?: string;
  q?: string;
  trash?: boolean;
  limit?: number;
  offset?: number;
}

const TRASH_DIR = '.trash';
const MAX_TRASH = 60;

async function listTrash(): Promise<NoteSummaryDTO[]> {
  const entries = (await listDir(TRASH_DIR))
    .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, MAX_TRASH);

  const rows = await mapLimited(entries, 4, async (entry): Promise<NoteSummaryDTO | null> => {
    try {
      const raw = await readOrNull(entry.path);
      if (raw === null) return null;
      const parsed = parseNote(raw, baseName(entry.path), entry.mtime ?? 0);
      const deletedAt = parsed.deleted_at ?? entry.mtime ?? 0;
      return {
        id: encodeId(entry.path),
        folder_id: null,
        title: parsed.title,
        excerpt: excerptOf(parsed.body),
        created_at: parsed.created,
        updated_at: deletedAt,
        deleted_at: deletedAt,
      };
    } catch {
      return null;
    }
  });
  return rows.filter((row): row is NoteSummaryDTO => row !== null);
}

export const notesApi = {
  async list(query: NoteListQuery = {}): Promise<NoteListResult> {
    const limit = query.limit ?? NOTE_LIMITS.defaultPageSize;
    const offset = query.offset ?? 0;

    let rows: NoteSummaryDTO[];
    if (query.trash) {
      rows = await listTrash();
    } else {
      const { notes } = await tree();
      rows = notes.map(summaryOf);

      if (query.folder_id) {
        const folder = query.folder_id === 'root' ? '' : decodeId(query.folder_id);
        rows = rows.filter((row) => {
          if (!row.folder_id) return folder === '';
          const rel = decodeId(row.folder_id);
          return rel === folder || rel.startsWith(`${folder}/`);
        });
      }
    }

    const keyword = query.q?.trim().toLowerCase();
    if (keyword) {
      rows = rows.filter(
        (row) =>
          row.title.toLowerCase().includes(keyword) || row.excerpt.toLowerCase().includes(keyword),
      );
    }

    rows.sort((a, b) => b.updated_at - a.updated_at);

    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      limit,
      offset,
    };
  },

  async create(input: { title?: string; content?: string; folder_id?: string | null }) {
    const dir = input.folder_id ? decodeId(input.folder_id) : '';
    if (dir) await getStorage().ensureDir(dir);

    const title = input.title?.trim() || '未命名';
    const rel = await uniqueRel(dir, sanitize(title), '.md');
    const now = Date.now();
    const meta: NoteMeta = { title, created: now, updated: now, tags: [] };
    const body = input.content ?? '';

    await getStorage().write(rel, serializeNote(meta, body));
    invalidateTree();
    return { note: noteOf(rel, meta, body) };
  },

  async get(id: string) {
    const rel = decodeId(id);
    const raw = await readOrNull(rel);
    if (raw === null) throw new StorageError('not_found', '笔记不存在', 404);
    const parsed = parseNote(raw, baseName(rel), Date.now());
    const meta: NoteMeta = {
      title: parsed.title,
      created: parsed.created,
      updated: parsed.updated,
      tags: parsed.tags,
      deleted_from: parsed.deleted_from,
      deleted_at: parsed.deleted_at,
    };
    return { note: noteOf(rel, meta, parsed.body) };
  },

  /**
   * 保存。标题即文件名：标题变了就顺带移动文件（自动补重名后缀），
   * 因此返回的 note.id 可能和传入的 id 不同，调用方需要跟上。
   */
  async update(
    id: string,
    patch: { title?: string; content?: string; folder_id?: string | null },
  ) {
    const rel = decodeId(id);
    const raw = await readOrNull(rel);
    if (raw === null) throw new StorageError('not_found', '笔记不存在', 404);

    const folderNow = parentOf(rel);
    const parsed = parseNote(raw, baseName(rel), Date.now());

    const title = patch.title !== undefined ? patch.title.trim() || '无标题笔记' : parsed.title;
    let body = patch.content !== undefined ? patch.content : parsed.body;
    const folderNext =
      patch.folder_id !== undefined ? (patch.folder_id ? decodeId(patch.folder_id) : '') : folderNow;

    let target = rel;
    const stem = sanitize(title);
    if (folderNext !== folderNow || stem !== stemOf(rel.slice(rel.lastIndexOf('/') + 1))) {
      if (folderNext !== folderNow && folderNext) await getStorage().ensureDir(folderNext);
      target = await uniqueRel(folderNext, stem, '.md', rel);
      if (target !== rel) {
        await getStorage().move(rel, target);
        // 附件目录与笔记同级，跟着一起走；标题变了，正文里指向它的引用也要改
        const fromDir = getAssetsDirPath(rel);
        const toDir = getAssetsDirPath(target);
        if (fromDir !== toDir) {
          await moveAssets(fromDir, toDir);
          const fromName = assetsDirName(rel);
          const toName = assetsDirName(target);
          if (fromName !== toName) body = rewriteAssetRefs(body, fromName, toName);
        }
        invalidateTree();
      }
    }

    const meta: NoteMeta = {
      title,
      created: parsed.created,
      updated: Date.now(),
      tags: parsed.tags,
    };
    await getStorage().write(target, serializeNote(meta, body));

    const later = cache();
    delete later[rel];
    persistCache();

    return { note: noteOf(target, meta, body) };
  },

  /** hard=true 为彻底删除；已经在回收站里的再删一次也等于彻底删除 */
  async remove(id: string, hard = false) {
    const rel = decodeId(id);
    const inTrash = rel.startsWith(`${TRASH_DIR}/`);

    if (hard || inTrash) {
      await getStorage().delete(rel);
      // 回收站里的附件目录按同一时间戳前缀配对，一起清掉
      await getStorage().delete(trashAssetsPath(rel));
      invalidateTree();
      return { hard: true };
    }

    const raw = await readOrNull(rel);
    if (raw === null) return { hard: false };

    await getStorage().ensureDir(TRASH_DIR);
    const parsed = parseNote(raw, baseName(rel), Date.now());
    const now = Date.now();
    const name = `${now}-${Math.random().toString(36).slice(2, 6)}-${baseName(rel)}.md`;
    const meta: NoteMeta = {
      title: parsed.title,
      created: parsed.created,
      updated: now,
      tags: parsed.tags,
      deleted_from: rel,
      deleted_at: now,
    };
    await getStorage().write(`${TRASH_DIR}/${name}`, serializeNote(meta, parsed.body));
    await getStorage().delete(rel);
    // 附件目录跟着进回收站，结构保持，恢复时再一起回来
    await moveAssets(getAssetsDirPath(rel), trashAssetsPath(`${TRASH_DIR}/${name}`));
    invalidateTree();
    return { hard: false };
  },

  /**
   * 恢复。原位置已被占用就放弃 —— 不再自动改名，免得「恢复出来的东西悄悄换了名字」。
   * WebDAV 没有多步原子操作，附件失败时按 best-effort 回滚。
   */
  async restore(id: string) {
    const rel = decodeId(id);
    const raw = await readOrNull(rel);
    if (raw === null) throw new StorageError('not_found', '笔记不存在', 404);

    const parsed = parseNote(raw, baseName(rel), Date.now());
    const target = parsed.deleted_from;
    if (!target) throw new StorageError('other', '这个文件不在回收站里', 400);

    // 前置校验：原路径上不能已经有东西，否则什么都不动
    if (await pathExists(target)) {
      throw new StorageError('conflict', '原位置已有同名文件，恢复已放弃', 409);
    }

    const dir = parentOf(target);
    if (dir) await getStorage().ensureDir(dir);

    const meta: NoteMeta = {
      title: parsed.title,
      created: parsed.created,
      updated: Date.now(),
      tags: parsed.tags,
    };
    await getStorage().write(target, serializeNote(meta, parsed.body));

    // 附件目录跟着回来；失败就把刚恢复的笔记撤回去，不留半截状态
    try {
      await moveAssets(trashAssetsPath(rel), getAssetsDirPath(target));
    } catch (error) {
      await getStorage().delete(target);
      const reason = error instanceof Error ? error.message : String(error);
      throw new StorageError('other', `附件恢复失败，已回滚：${reason}`, 0);
    }

    await getStorage().delete(rel);
    invalidateTree();
    return { note: noteOf(target, meta, parsed.body) };
  },
};

/* ------------------------------ 文件夹 API ------------------------------ */

export const foldersApi = {
  async list() {
    const { notes, dirs } = await tree();

    const countByDir = new Map<string, number>();
    for (const note of notes) {
      const dir = parentOf(note.path);
      countByDir.set(dir, (countByDir.get(dir) ?? 0) + 1);
    }

    const items: FolderDTO[] = dirs.map((dir) => {
      const parent = parentOf(dir.path);
      return {
        id: encodeId(dir.path),
        parent_id: parent ? encodeId(parent) : null,
        name: dir.name,
        created_at: dir.mtime ?? 0,
        updated_at: dir.mtime ?? 0,
        note_count: countByDir.get(dir.path) ?? 0,
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    return { items };
  },

  async create(input: { name: string; parent_id?: string | null }) {
    const parent = input.parent_id ? decodeId(input.parent_id) : '';
    const name = sanitize(input.name);
    const rel = parent ? `${parent}/${name}` : name;
    await getStorage().mkdir(rel);
    invalidateTree();
    const parentFull = parentOf(rel);
    return {
      folder: {
        id: encodeId(rel),
        parent_id: parentFull ? encodeId(parentFull) : null,
        name,
        created_at: Date.now(),
        updated_at: Date.now(),
        note_count: 0,
      } satisfies FolderDTO,
    };
  },

  async rename(id: string, name: string) {
    const rel = decodeId(id);
    const parent = parentOf(rel);
    // 必须把自己排除掉，否则「改成同名」会被当成重名冲突，多出一个「名字 2」
    const target = await uniqueRel(parent, sanitize(name), '', rel);
    if (target !== rel) await getStorage().move(rel, target);
    invalidateTree();
    return {
      folder: {
        id: encodeId(target),
        parent_id: parent ? encodeId(parent) : null,
        name: sanitize(name),
        created_at: Date.now(),
        updated_at: Date.now(),
        note_count: 0,
      } satisfies FolderDTO,
    };
  },

  /** 只解散文件夹：里面内容逐个上移到父级，再删掉这个空目录 */
  async remove(id: string) {
    const rel = decodeId(id);
    const parent = parentOf(rel);
    const children = (await listDir(rel)).filter((entry) => !entry.name.startsWith('.'));

    await mapLimited(children, 3, async (child) => {
      const ext = child.isDirectory ? '' : '.md';
      const target = await uniqueRel(parent, stemOf(child.name), ext);
      await getStorage().move(child.path, target);
    });

    await getStorage().delete(rel);
    invalidateTree();
    return { moved_to: parent ? encodeId(parent) : null };
  },
};
