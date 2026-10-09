/**
 * 笔记数据层：一切读写都直接落到用户自己的坚果云（WebDAV），本地不存数据库。
 *
 * 文件模型
 *   <同步根>/<文件夹…>/<标题>.md   一篇笔记 = 一个 .md 文件
 *   <同步根>/.trash/<时间>-<随机>-<标题>.md   删除先进回收站，frontmatter 记原路径
 *   文件夹 = 真目录；以 `.` 开头的目录（含 .trash）不参与展示
 *
 * 对外暴露的 DTO 形状与之前走 HTTP 时完全一致，视图层基本不用改。
 * 笔记/文件夹的 id = 相对路径的 base64url（路径含 `/`，直接塞进路由会破坏匹配）。
 */

import { NOTE_LIMITS, type FolderDTO, type NoteDTO, type NoteListResult, type NoteSummaryDTO } from '@donote/shared';
import { useNutstoreStore } from '@/stores/nutstore';
import { davFetch } from './transport';
import { DAV_ORIGIN_BASE, davPath } from './webdav';
import { excerptOf, parseNote, serializeNote, type NoteMeta } from './frontmatter';

export class DavError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DavError';
    this.status = status;
  }
}

/* ------------------------------ 路径工具 ------------------------------ */

function store() {
  return useNutstoreStore();
}

function auth(): string {
  const c = store().credentials();
  return `Basic ${btoa(`${c.account}:${c.appPassword}`)}`;
}

function rootRel(): string {
  return (store().root || '/DoNote').replace(/\/+$/, '');
}

/** 相对路径 → 以同步根开头的绝对路径（每段都做 URL 编码）。rel 为空时就是同步根本身 */
function absPath(rel: string): string {
  const clean = rel.replace(/^\/+|\/+$/g, '');
  const base = rootRel();
  if (!clean) return base;
  return `${base}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

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

/* ------------------------------ WebDAV 原语 ------------------------------ */

interface DavEntry {
  rel: string;
  name: string;
  isDir: boolean;
  mtime: number;
}

/** href → 相对同步根的路径；不属于同步根则返回 null */
function hrefToRel(href: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(href);
  } catch {
    path = href;
  }
  const davPrefix = new URL(DAV_ORIGIN_BASE).pathname;
  const at = path.indexOf(davPrefix);
  if (at >= 0) path = path.slice(at + davPrefix.length);
  const base = rootRel();
  if (path.replace(/\/+$/, '') === base) return '';
  if (!path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1).replace(/\/+$/, '');
}

/** 只取状态为 200 的那组 propstat，避免读到 404 组的空壳 */
function pickProp(node: Element): Element | null {
  const stats = node.getElementsByTagNameNS('DAV:', 'propstat');
  for (const stat of Array.from(stats)) {
    const status = stat.getElementsByTagNameNS('DAV:', 'status')[0]?.textContent ?? '';
    if (status.includes(' 200 ')) {
      const prop = stat.getElementsByTagNameNS('DAV:', 'prop')[0];
      if (prop) return prop;
    }
  }
  return null;
}

function parseMultistatus(xml: string, baseRel: string): DavEntry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: DavEntry[] = [];
  for (const node of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
    const href = node.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent?.trim();
    if (!href) continue;
    const prop = pickProp(node);
    if (!prop) continue;
    const rel = hrefToRel(href);
    if (rel === null || rel === baseRel) continue;
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (!name) continue;
    const mtimeText = prop.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent ?? '';
    out.push({
      rel,
      name,
      isDir: prop.getElementsByTagNameNS('DAV:', 'collection').length > 0,
      mtime: Date.parse(mtimeText) || 0,
    });
  }
  return out;
}

async function propfindDir(rel: string): Promise<DavEntry[]> {
  let res: Response;
  try {
    res = await davFetch(davPath(absPath(rel)), {
      method: 'PROPFIND',
      headers: {
        Authorization: auth(),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getlastmodified/></prop></propfind>',
    });
  } catch {
    throw new DavError('连不上坚果云，请检查网络', 0);
  }
  if (res.status === 404) return [];
  if (res.status === 401) throw new DavError('账号或应用密码已失效，请重新连接', 401);
  if (res.status !== 207) throw new DavError(`读取目录失败（HTTP ${res.status}）`, res.status);
  return parseMultistatus(await res.text(), rel);
}

async function getText(rel: string): Promise<string | null> {
  const res = await davFetch(davPath(absPath(rel)), { headers: { Authorization: auth() } });
  if (res.status === 404) return null;
  if (!res.ok) throw new DavError(`读取笔记失败（HTTP ${res.status}）`, res.status);
  return res.text();
}

async function putText(rel: string, text: string): Promise<void> {
  const res = await davFetch(davPath(absPath(rel)), {
    method: 'PUT',
    headers: { Authorization: auth(), 'Content-Type': 'text/markdown; charset=utf-8' },
    body: text,
  });
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new DavError(`保存失败（HTTP ${res.status}）`, res.status);
  }
}

/** 已存在（405）也算成功 */
async function mkcol(rel: string): Promise<void> {
  const res = await davFetch(davPath(absPath(rel)), {
    method: 'MKCOL',
    headers: { Authorization: auth() },
  });
  if (res.status === 201 || res.status === 405) return;
  throw new DavError(`创建文件夹失败（HTTP ${res.status}）`, res.status);
}

/** 逐级建目录，跳过的层级已存在也不会报错 */
async function ensureDir(rel: string): Promise<void> {
  if (!rel) return;
  let acc = '';
  for (const seg of rel.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    await mkcol(acc);
  }
}

async function removeFile(rel: string): Promise<void> {
  const res = await davFetch(davPath(absPath(rel)), {
    method: 'DELETE',
    headers: { Authorization: auth() },
  });
  if (res.status === 204 || res.status === 200 || res.status === 404) return;
  throw new DavError(`删除失败（HTTP ${res.status}）`, res.status);
}

/** Destination 必须是绝对地址，因此不能复用 DAV_BASE（dev 下它是同源代理前缀） */
async function moveEntry(from: string, to: string): Promise<void> {
  const res = await davFetch(davPath(absPath(from)), {
    method: 'MOVE',
    headers: {
      Authorization: auth(),
      Destination: `${DAV_ORIGIN_BASE}${absPath(to)}`,
      Overwrite: 'F',
    },
  });
  if (res.status === 201 || res.status === 204) return;
  if (res.status === 412) throw new DavError('目标位置已有同名条目', 412);
  throw new DavError(`移动失败（HTTP ${res.status}）`, res.status);
}

/* ------------------------------ 目录树 ------------------------------ */

interface Tree {
  notes: DavEntry[];
  dirs: DavEntry[];
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
    const results = await Promise.all(group.map((item) => propfindDir(item.rel).catch(() => [] as DavEntry[])));
    const next: { rel: string; depth: number }[] = [];

    results.forEach((entries, index) => {
      visited++;
      const depth = group[index].depth;
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDir) {
          acc.dirs.push(entry);
          if (depth + 1 < MAX_DEPTH) next.push({ rel: entry.rel, depth: depth + 1 });
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

function cachedExcerpt(entry: DavEntry): string {
  const row = cache()[entry.rel];
  return row && row.m === entry.mtime ? row.e : '';
}

/** 并发受限的 map，避免一次甩出上百个请求被坚果云限流 */
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
    .filter((entry) => !filled[entry.rel] || filled[entry.rel].m !== entry.mtime)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  if (!pending.length) return 0;

  let done = 0;
  await mapLimited(pending, 2, async (entry) => {
    try {
      const raw = await getText(entry.rel);
      if (raw === null) return;
      filled[entry.rel] = { m: entry.mtime, e: excerptOf(parseNote(raw, entry.name, entry.mtime).body) };
      done++;
    } catch {
      // 单篇读失败不该拖垮整次补齐
    }
  });
  if (done) persistCache();
  return done;
}

/* ------------------------------ 组装 DTO ------------------------------ */

function summaryOf(entry: DavEntry): NoteSummaryDTO {
  const folder = parentOf(entry.rel);
  return {
    id: encodeId(entry.rel),
    folder_id: folder ? encodeId(folder) : null,
    title: baseName(entry.rel),
    excerpt: cachedExcerpt(entry),
    created_at: entry.mtime,
    updated_at: entry.mtime,
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
  const entries = await propfindDir(dir);
  const taken = new Set(entries.filter((entry) => entry.rel !== exclude).map((entry) => entry.name));
  let candidate = `${stem}${ext}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${stem} ${n}${ext}`;
    n++;
  }
  return dir ? `${dir}/${candidate}` : candidate;
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
  const entries = (await propfindDir(TRASH_DIR))
    .filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_TRASH);

  const rows = await mapLimited(entries, 4, async (entry): Promise<NoteSummaryDTO | null> => {
    try {
      const raw = await getText(entry.rel);
      if (raw === null) return null;
      const parsed = parseNote(raw, baseName(entry.rel), entry.mtime);
      const deletedAt = parsed.deleted_at ?? entry.mtime;
      return {
        id: encodeId(entry.rel),
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
    if (dir) await ensureDir(dir);

    const title = input.title?.trim() || '未命名';
    const rel = await uniqueRel(dir, sanitize(title), '.md');
    const now = Date.now();
    const meta: NoteMeta = { title, created: now, updated: now, tags: [] };
    const body = input.content ?? '';

    await putText(rel, serializeNote(meta, body));
    invalidateTree();
    return { note: noteOf(rel, meta, body) };
  },

  async get(id: string) {
    const rel = decodeId(id);
    const raw = await getText(rel);
    if (raw === null) throw new DavError('笔记不存在', 404);
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
    const raw = await getText(rel);
    if (raw === null) throw new DavError('笔记不存在', 404);

    const folderNow = parentOf(rel);
    const parsed = parseNote(raw, baseName(rel), Date.now());

    const title = patch.title !== undefined ? patch.title.trim() || '无标题笔记' : parsed.title;
    const body = patch.content !== undefined ? patch.content : parsed.body;
    const folderNext =
      patch.folder_id !== undefined ? (patch.folder_id ? decodeId(patch.folder_id) : '') : folderNow;

    let target = rel;
    const stem = sanitize(title);
    if (folderNext !== folderNow || stem !== stemOf(rel.slice(rel.lastIndexOf('/') + 1))) {
      if (folderNext !== folderNow && folderNext) await ensureDir(folderNext);
      target = await uniqueRel(folderNext, stem, '.md', rel);
      if (target !== rel) await moveEntry(rel, target);
      invalidateTree();
    }

    const meta: NoteMeta = {
      title,
      created: parsed.created,
      updated: Date.now(),
      tags: parsed.tags,
    };
    await putText(target, serializeNote(meta, body));

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
      await removeFile(rel);
      invalidateTree();
      return { hard: true };
    }

    const raw = await getText(rel);
    if (raw === null) return { hard: false };

    await ensureDir(TRASH_DIR);
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
    await putText(`${TRASH_DIR}/${name}`, serializeNote(meta, parsed.body));
    await removeFile(rel);
    invalidateTree();
    return { hard: false };
  },

  async restore(id: string) {
    const rel = decodeId(id);
    const raw = await getText(rel);
    if (raw === null) throw new DavError('笔记不存在', 404);

    const parsed = parseNote(raw, baseName(rel), Date.now());
    const from = parsed.deleted_from;
    if (!from) throw new DavError('这个文件不在回收站里', 400);

    const dir = parentOf(from);
    if (dir) await ensureDir(dir);

    const target = await uniqueRel(dir, sanitize(parsed.title), '.md');
    const meta: NoteMeta = {
      title: parsed.title,
      created: parsed.created,
      updated: Date.now(),
      tags: parsed.tags,
    };
    await putText(target, serializeNote(meta, parsed.body));
    await removeFile(rel);
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
      const dir = parentOf(note.rel);
      countByDir.set(dir, (countByDir.get(dir) ?? 0) + 1);
    }

    const items: FolderDTO[] = dirs.map((dir) => {
      const parent = parentOf(dir.rel);
      return {
        id: encodeId(dir.rel),
        parent_id: parent ? encodeId(parent) : null,
        name: dir.name,
        created_at: dir.mtime,
        updated_at: dir.mtime,
        note_count: countByDir.get(dir.rel) ?? 0,
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    return { items };
  },

  async create(input: { name: string; parent_id?: string | null }) {
    const parent = input.parent_id ? decodeId(input.parent_id) : '';
    const name = sanitize(input.name);
    const rel = parent ? `${parent}/${name}` : name;
    await mkcol(rel);
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
    if (target !== rel) await moveEntry(rel, target);
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
    const children = (await propfindDir(rel)).filter((entry) => !entry.name.startsWith('.'));

    await mapLimited(children, 3, async (child) => {
      const ext = child.isDir ? '' : '.md';
      const target = await uniqueRel(parent, stemOf(child.name), ext);
      await moveEntry(child.rel, target);
    });

    await removeFile(rel);
    invalidateTree();
    return { moved_to: parent ? encodeId(parent) : null };
  },
};
