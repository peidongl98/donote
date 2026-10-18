/**
 * 笔记数据层：一切读写都落到用户自己的网盘，本地不存数据库。
 *
 * 文件模型
 *   <同步根>/<文件夹…>/<标题>.md   一篇笔记 = 一个 .md 文件
 *   <同步根>/<目录…>/index.md      该目录是一个**页面**（可写正文，也可装子页面）
 *   <同步根>/.trash/<时间>-<随机>-<标题>.md   删除先进回收站，frontmatter 记原路径
 *   文件夹 = 真目录；以 `.` 开头的目录（含 .trash）不参与展示
 *
 * 页面的判定只看一条：目录里有 index.md（大小写不敏感）→ 页面；没有 → 纯文件夹。
 * 因此**零迁移**：现有笔记与文件夹在新模型下行为完全不变，index.md 只在用户主动建子页面时出现。
 * 页面笔记的 id 与普通笔记同一套（路径的 base64url），所以 /notes/:id 直接复用。
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

/**
 * 是不是「页面文件」——即某个目录下的 `index.md`。
 *
 * ⚠️ 判据必须带目录前缀（`/index.md`）：同步根下的 `index.md`（rel 就是 `index.md`）
 * 只是根目录里一篇普通笔记，根目录本身不是页面。
 */
export function isPageFile(rel: string): boolean {
  return rel.toLowerCase().endsWith('/index.md');
}

/** 页面所在的目录路径；不是页面文件返回 null */
export function pageDirOf(rel: string): string | null {
  return isPageFile(rel) ? parentOf(rel) : null;
}

/**
 * 「这篇笔记的子页面该落在哪」——页面用它自己的目录，普通笔记用它所在的目录。
 *
 * 普通笔记没有属于自己的目录，所以退化到所在目录（子页面与它平级）：可预期，且
 * 不需要挪动用户的任何既有文件。详见 docs/index-md-design.md §2.5。
 */
export function containerDirOf(rel: string): string {
  return pageDirOf(rel) ?? parentOf(rel);
}

/** 显示标题：页面取目录末段名（fs 里那个文件叫 index.md，不能拿它当标题） */
function titleOf(rel: string): string {
  const dir = pageDirOf(rel);
  return dir === null ? baseName(rel) : lastSegment(dir);
}

/** 目录里有没有 index.md —— 建同名笔记时要拿它判「会不会与页面撞车」 */
async function hasIndexFile(dirRel: string): Promise<boolean> {
  if (!dirRel) return false;
  try {
    const entries = await getStorage().list(dirRel, { fresh: true });
    return entries.some((entry) => !entry.isDirectory && entry.name.toLowerCase() === 'index.md');
  } catch {
    return false;
  }
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

/**
 * 列目录。适配器返回的 mtime 是可选的，这里补齐成数字，后续不用到处判空。
 * fresh=true 跳过本地缓存 —— 凡是用这份列表决定「叫什么名字 / 会不会覆盖」的地方都要传，
 * 否则缓存里的旧列表会让查重失效（数据层不加缓存时它一直是新鲜的）。
 */
async function listDir(rel: string, fresh = false): Promise<DirEntry[]> {
  const entries = await getStorage().list(rel, fresh ? { fresh: true } : undefined);
  return entries.map((entry) => ({ ...entry, mtime: entry.mtime ?? 0 }));
}

/**
 * 读文本。把「不存在」翻译成 null，其余错误照旧抛出。
 *
 * preferCache 只给「打开来看」用 —— 读改写一律走云端，免得用旧内容覆盖别人的改动。
 * `verify` 默认关：这一路的副本是拿来**补显示**的（列表摘要、回收站标题、原路径），
 * 不需要最新。打开正文那一路（`get`）要传 true，否则可能读到旧内容。
 */
async function readOrNull(
  rel: string,
  preferCache = false,
  verify = false,
): Promise<string | null> {
  try {
    return await getStorage().read(rel, preferCache ? { preferCache: true, verify } : undefined);
  } catch (error) {
    if (error instanceof StorageError && error.code === 'not_found') return null;
    throw error;
  }
}

/* ------------------------------ 目录树 ------------------------------ */

interface Tree {
  notes: DirEntry[];
  dirs: DirEntry[];
  /** 目录路径 → 该目录里的 index.md 条目。**有值即「这个目录是一个页面」** */
  pages: Map<string, DirEntry>;
}

/** 全部「笔记条目」，含页面（页面的条目就是它目录里的 index.md） */
function allEntries(data: Tree): DirEntry[] {
  return [...data.notes, ...data.pages.values()];
}

const MAX_DIRS = 300;
const MAX_DEPTH = 8;

/**
 * 广度优先递归；同层一次提交 4 个目录。
 *
 * ⚠️ 出网其实仍是串行的 —— 全局闸门（storage/gate.ts）把并发压到了 1。
 * 这里的 4 只是同时把 4 个任务排进闸门队列，省掉「等一个、再排下一个」的空转。
 */
async function walkTree(): Promise<Tree> {
  const acc: Tree = { notes: [], dirs: [], pages: new Map() };
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
      const { rel, depth } = group[index];

      // 这一层有没有 index.md：有的话**这个目录就是一个页面**，index.md 不再算普通笔记，
      // 它由 pages 单独代表（标题取目录名，而不是「index」）。
      // ⚠️ 同步根不算页面：根目录里的 index.md 只是根下一篇普通笔记。
      const indexEntry = rel
        ? entries.find(
            (entry) =>
              !entry.isDirectory &&
              !entry.name.startsWith('.') &&
              entry.name.toLowerCase() === 'index.md',
          )
        : undefined;
      if (indexEntry) acc.pages.set(rel, indexEntry);

      for (const entry of entries) {
        if (entry === indexEntry) continue;
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

    frontier = frontier.concat(next);
  }
  return acc;
}

/** 一次页面加载会同时要列表和文件夹，这里合并成一次遍历 */
let treeCache: { at: number; data: Tree } | null = null;
/** 正在跑的那次遍历。同时要列表和文件夹时共用它，不重复走一遍目录树 */
let treePending: Promise<Tree> | null = null;

/** 缓存层在后台校验出差异时，由 stores/sync 调这个把遍历结果作废 */
export function invalidateTree(): void {
  treeCache = null;
}

async function tree(force = false): Promise<Tree> {
  if (!force && treeCache && Date.now() - treeCache.at < 3000) return treeCache.data;
  if (!treePending) {
    treePending = walkTree()
      .then((data) => {
        treeCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        treePending = null;
      });
  }
  return treePending;
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
  /** 顺手存下来的标签：补摘要时已经读过整篇，不额外发请求 */
  t?: string[];
  /** 出链（正文里出现的 `[[名字]]`）：同样是顺手，反链索引由它派生 */
  l?: string[];
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

function cachedTags(entry: DirEntry): string[] {
  const row = cache()[entry.path];
  return row && row.m === entry.mtime ? (row.t ?? []) : [];
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
  const data = await tree();
  const filled = cache();
  const pending = allEntries(data)
    .filter((entry) => !filled[entry.path] || filled[entry.path].m !== entry.mtime)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, limit);
  if (!pending.length) return 0;

  let done = 0;
  await mapLimited(pending, 2, async (entry) => {
    try {
      /*
       * 本地有副本就直接拿副本来算摘要 —— 这一步只是**给列表补显示**，不该为了它
       * 把整库的正文重新 GET 一遍（97 篇就是 97 次请求、几十次排队）。副本过期由
       * 缓存层自己的后台校验负责换新，换完会通知列表重取。
       */
      const raw = await readOrNull(entry.path, true);
      if (raw === null) return;
      const parsed = parseNote(raw, entry.name, entry.mtime ?? 0);
      filled[entry.path] = {
        m: entry.mtime ?? 0,
        e: excerptOf(parsed.body),
        t: parsed.tags,
        l: wikilinksIn(parsed.body),
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

/**
 * `[[笔记名]]`。
 *
 * 🔴 开头那对方括号要**容忍反斜杠**：Markdown 序列化器怕 `[` 被当成链接起头，
 * 落盘时会把它转义成 `\[\[名字]]`（实测见 `.workbuddy/tmp/probe-wikilink.cjs` 的输出）。
 * 编辑器里读回来仍然是 `[[名字]]`（解析时会还原），所以链接本身不受影响；
 * 但**正文级的扫描器**（出链、改名改写、摘要）看的是磁盘原文，认不出转义形式就等于
 * 反链永远为空、改名永远不同步。两种写法都认，用户手写哪一种都行。
 */
const WIKILINK_RE = /(?:\\?\[){2}([^[\]\n]+)(?:\\?\]){2}/g;

/**
 * 取出正文里所有的 `[[笔记名]]`（去重、保序）。
 *
 * 落盘存的就是原文 `[[名字]]`，**不存路径** —— 笔记改名或搬家后引用不会失效，
 * 解析时按名字反查（`notesApi.titleIndex`）。索引由摘要缓存派生，可随时重建。
 */
export function wikilinksIn(body: string): string[] {
  const out: string[] = [];
  for (const hit of body.matchAll(WIKILINK_RE)) {
    const name = hit[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 把正文里指向 `from` 的 `[[…]]` 换成 `to`。一个都没命中时返回 null（调用方据此跳过写盘）。
 *
 * 逐段走与 `wikilinksIn` 同一个正则、比的是 trim 过的名字 ——
 * 不用带正则元字符的字符串拼接去 replace，名字里有 `.` `(` 也不会误伤。
 * 换出来的统一是**没转义**的 `[[名字]]`，对用户最直观。
 */
function replaceWikilink(body: string, from: string, to: string): string | null {
  let hit = false;
  const out = body.replace(WIKILINK_RE, (whole, name: string) => {
    if (name.trim() !== from) return whole;
    hit = true;
    return `[[${to}]]`;
  });
  return hit ? out : null;
}

/**
 * 改名之后，把别的笔记里指向**旧名字**的 `[[…]]` 一起改成新名字。
 *
 * 链接落盘存的是名字不是路径，所以「改名」这一步必须补上，否则引用会挂掉。
 * 只动摘要缓存里**确实记过提到过旧名字**的那几篇（那份清单本来就是反链要用的，零额外遍历）——
 * 不扫全仓、不读没提到过它的正文。
 *
 * 每篇走的是与 `notesApi.update` 完全相同的「读 → parseNote → serializeNote → 写回」，
 * 不新增任何序列化路径。**单篇失败只让那一条链接留在旧名字上**（渲染成红色），
 * 绝不抛出去影响调用方 —— 改名本身已经落盘了，不能被这里的失败连累。
 *
 * 缓存没补齐时可能有漏网的引用（那些链接会显示成红色，点一下能重建）。
 */
async function propagateRename(from: string, to: string): Promise<number> {
  if (!from || from === to) return 0;
  const rows = entryTitles(await tree()).filter((row) => cache()[row.rel]?.l?.includes(from));
  let done = 0;

  for (const row of rows) {
    try {
      const raw = await readOrNull(row.rel);
      if (raw === null) continue;
      const parsed = parseNote(raw, row.title, Date.now());
      const body = replaceWikilink(parsed.body, from, to);
      if (body === null) continue;
      const meta: NoteMeta = {
        title: parsed.title,
        created: parsed.created,
        updated: parsed.updated,
        tags: parsed.tags,
        deleted_from: parsed.deleted_from,
        deleted_at: parsed.deleted_at,
      };
      await getStorage().write(row.rel, serializeNote(meta, body));
      delete cache()[row.rel];
      done++;
    } catch {
      // 这一篇没改成：那条链接留在旧名字上，用户看得见（红色），其它篇继续
    }
  }

  if (done) {
    persistCache();
    invalidateTree();
  }
  return done;
}

/** 目录路径 → 给人看的层级串（`a/b` → `a / b`） */
function folderLabel(dir: string): string {
  return dir ? dir.split('/').join(' / ') : '';
}

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
    tags: cachedTags(entry),
    path_label: folderLabel(folder),
  };
}

/**
 * 页面的列表项。标题取**目录末段名**（fs 里那个文件叫 `index.md`，不能拿它当标题），
 * id 与普通笔记同一套（路径 base64url），folder_id 是页面的**父目录** ——
 * 于是页面在侧栏里与同级条目并列，`/notes/:id` 也不用新增路由。
 */
function pageSummaryOf(dirRel: string, entry: DirEntry): NoteSummaryDTO {
  const parent = parentOf(dirRel);
  return {
    id: encodeId(entry.path),
    folder_id: parent ? encodeId(parent) : null,
    title: lastSegment(dirRel),
    excerpt: cachedExcerpt(entry),
    created_at: entry.mtime ?? 0,
    updated_at: entry.mtime ?? 0,
    deleted_at: null,
    tags: cachedTags(entry),
    path_label: folderLabel(parent),
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
    tags: meta.tags,
  };
}

/**
 * 目标目录下挑一个没被占用的文件名。
 *
 * `avoidMdFile` 只给**建页面 / 改页面标题**用（`ext === ''`）：页面名要避让同名的 `X.md`，
 * 否则「页面 X」与「笔记 X」会并列出现（设计 §2.2）。纯文件夹命名不传它 ——
 * 目录与同名 .md 共存是既有行为，不动。
 */
async function uniqueRel(
  dir: string,
  stem: string,
  ext: string,
  exclude?: string,
  avoidMdFile = false,
): Promise<string> {
  const entries = await listDir(dir, true);
  const taken = new Set(
    entries.filter((entry) => entry.path !== exclude).map((entry) => entry.name),
  );

  /**
   * 建**笔记**（`ext === '.md'`）时还要避让「同名目录是个页面」：
   * `X/` 里有 index.md 时，`X.md` 与它同名不同物，并列摆着必然让用户困惑（设计 §2.2）。
   * 只在真的撞上同名目录时才多查一次，平时零额外请求。
   * 反方向（建页面时避让已有 `X.md`）在 createPage 里挡。
   */
  const clashesPage = async (name: string): Promise<boolean> => {
    if (ext !== '.md') return false;
    const same = stemOf(name);
    if (!taken.has(same)) return false;
    return hasIndexFile(dir ? `${dir}/${same}` : same);
  };

  let candidate = `${stem}${ext}`;
  let n = 2;
  while (
    taken.has(candidate) ||
    (await clashesPage(candidate)) ||
    (avoidMdFile && ext === '' && taken.has(`${candidate}.md`))
  ) {
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
  /*
   * 先直接 MOVE 整棵。绝大多数场景目标都不存在（软删时 toDir 的前缀就是这一次的
   * 时间戳 + 随机后缀；恢复时目标位置刚被清空），而原来为了判断这件事要先 stat 一次
   * —— 软删每一篇笔记都白花一个排队位。
   *
   * 只有真撞上（目标已有同名附件目录，MOVE 回 412）才走下面逐项合并那条路：
   * 让服务端去判，比先问一遍更准，也只在例外时付代价。
   */
  try {
    await getStorage().move(fromDir, toDir);
    return;
  } catch (error) {
    if (!(error instanceof StorageError) || error.code !== 'conflict') throw error;
  }

  // 目标与来源都取新鲜的列表：这里要拿名字去避让，用旧列表会把同名附件覆盖掉
  const taken = new Set((await listDir(toDir, true)).map((entry) => entry.name));
  for (const entry of await listDir(fromDir, true)) {
    const name = uniqueName(entry.name, taken);
    taken.add(name);
    await getStorage().move(entry.path, `${toDir}/${name}`);
  }
  await getStorage().delete(fromDir);
}

/** 全部笔记条目（含页面）的「相对路径 + 显示名」 */
function entryTitles(data: Tree): Array<{ rel: string; title: string }> {
  return [
    ...data.notes.map((entry) => ({ rel: entry.path, title: baseName(entry.path) })),
    ...[...data.pages].map(([dirRel, entry]) => ({ rel: entry.path, title: lastSegment(dirRel) })),
  ];
}

/* ------------------------------ 笔记 API ------------------------------ */

export interface NoteListQuery {
  /** 省略 = 全部；'root' 或空 = 未归类；其它 = 文件夹 id（含其子文件夹） */
  folder_id?: string;
  q?: string;
  /** 只看带这个标签的（侧栏点标签进来） */
  tag?: string;
  trash?: boolean;
  limit?: number;
  offset?: number;
}

const TRASH_DIR = '.trash';
/**
 * 回收站首屏最多列几条。
 * 曾经是 60：副本 miss 时每篇都要 GET 一次正文，60 条就是 60 次请求，
 * 而回收站首屏（且按 mtime 倒序）根本用不到 60 条 —— 20 条足够翻。
 */
const MAX_TRASH = 20;

/** 笔记详情页正文下方「子项」列表的一行 */
export interface PageChild {
  /** page = 子目录里有 index.md；folder = 纯文件夹；note = 普通笔记 */
  kind: 'page' | 'folder' | 'note';
  id: string;
  title: string;
  updated_at: number;
  excerpt: string;
}

async function listTrash(): Promise<NoteSummaryDTO[]> {
  const entries = (await listDir(TRASH_DIR))
    .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, MAX_TRASH);

  const rows = await mapLimited(entries, 4, async (entry): Promise<NoteSummaryDTO | null> => {
    try {
      // 回收站的正文在软删那一刻就落过本地副本，优先用副本 —— 打开回收站不再逐篇 GET
      const raw = await readOrNull(entry.path, true);
      if (raw === null) return null;
      const parsed = parseNote(raw, baseName(entry.path), entry.mtime ?? 0);
      const deletedAt = parsed.deleted_at ?? entry.mtime ?? 0;
      return {
        id: encodeId(entry.path),
        folder_id: null,
        title: parsed.title,
        excerpt: excerptOf(parsed.body),
        tags: parsed.tags,
        created_at: parsed.created,
        updated_at: deletedAt,
        deleted_at: deletedAt,
        path_label: '',
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
      const data = await tree();
      // 页面（有 index.md 的目录）本身就是一篇笔记，跟普通笔记进同一个列表 ——
      // 列表页、搜索、文件夹详情都要能看到它
      rows = [
        ...data.notes.map(summaryOf),
        ...[...data.pages].map(([dirRel, entry]) => pageSummaryOf(dirRel, entry)),
      ];

      if (query.folder_id) {
        // 只算直系子级：与 FolderDTO.note_count 一个口径。
        // 含后代会让「这个文件夹有几篇」和「点进去看到几篇」对不上，
        // 批次 4 的 index.md 模型下递归更是错的。
        const folder = query.folder_id === 'root' ? '' : decodeId(query.folder_id);
        rows = rows.filter((row) => (row.folder_id ? decodeId(row.folder_id) : '') === folder);
      }
    }

    const tag = query.tag?.trim();
    if (tag) rows = rows.filter((row) => row.tags.includes(tag));

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

  /**
   * 新建一个**页面**：`<父目录>/<名字>/index.md`。
   * 页面 = 目录 + index.md，所以是两步：建目录、写正文（WebDAV 没有多步原子操作）。
   */
  async createPage(input: { parent_dir?: string; title?: string; content?: string }) {
    const parent = input.parent_dir ?? '';
    if (parent) await getStorage().ensureDir(parent);

    const wanted = input.title?.trim() || '未命名';
    // avoidMdFile：页面名要避让同名的 X.md，不然「页面 X」与「笔记 X」并列摆着
    const dir = await uniqueRel(parent, sanitize(wanted), '', undefined, true);
    await getStorage().mkdir(dir);

    const now = Date.now();
    // 标题以**落盘的目录名**为准（查重可能补过后缀）
    const meta: NoteMeta = { title: lastSegment(dir), created: now, updated: now, tags: [] };
    const body = input.content ?? '';
    const rel = `${dir}/index.md`;
    await getStorage().write(rel, serializeNote(meta, body));
    invalidateTree();
    return { note: noteOf(rel, meta, body) };
  },

  /**
   * 笔记详情页正文下方要列的子项：**这篇笔记所在目录**里的直系条目。
   * 页面 → 它自己的目录；普通笔记 → 它所在的目录（子页面与它平级）。
   * 页面自己（那个 index.md）不出现在结果里。
   */
  async childrenOf(id: string): Promise<PageChild[]> {
    const rel = decodeId(id);
    const dir = containerDirOf(rel);
    const entries = await listDir(dir);
    const out: PageChild[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || isAssetsDir(entry.name)) continue;
      if (entry.isDirectory) {
        const isPage = await hasIndexFile(entry.path);
        out.push({
          kind: isPage ? 'page' : 'folder',
          id: isPage ? encodeId(`${entry.path}/index.md`) : encodeId(entry.path),
          title: entry.name,
          updated_at: entry.mtime ?? 0,
          excerpt: '',
        });
      } else if (
        entry.name.toLowerCase().endsWith('.md') &&
        // 别把「这篇」自己列成它自己的子项（普通笔记的落点就是它所在的目录）
        entry.path !== rel &&
        !isPageFile(entry.path)
      ) {
        out.push({
          kind: 'note',
          id: encodeId(entry.path),
          title: baseName(entry.path),
          updated_at: entry.mtime ?? 0,
          excerpt: cachedExcerpt(entry),
        });
      }
    }

    // 先页面 / 文件夹（按名），后笔记（新的在前）—— 与列表页、侧栏同一个口味
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'note' ? 1 : -1;
      return a.kind === 'note'
        ? b.updated_at - a.updated_at
        : a.title.localeCompare(b.title, 'zh');
    });
    return out;
  },

  /**
   * 笔记名 → 笔记 id。`[[wiki]]` 链接的补全与解析都用它。
   * 从同一次目录遍历里算，不额外发请求；同名多篇时取**路径最浅**的那一篇（最靠外的）。
   */
  async titleIndex(): Promise<Record<string, string>> {
    const rows = entryTitles(await tree()).sort(
      (a, b) => a.rel.split('/').length - b.rel.split('/').length,
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (!(row.title in out)) out[row.title] = encodeId(row.rel);
    }
    return out;
  },

  /**
   * 反向链接：谁的正文里提到了 `title`。
   *
   * 出链是在补摘要时顺手记进摘要缓存的（`CacheRow.l`），所以这里先确保缓存补齐、
   * 再从缓存派生 —— 不额外读任何一篇正文，也不落第二个索引文件（可随时重建）。
   *
   * 🔴 只补**一轮**（40 篇），不循环到补完为止：坚果云免费版限 600 请求 / 30 分钟，
   * 一循环就会在每次打开笔记时把整个仓库重读一遍，额度烧光之后同步直接 503
   * （表现出来是「笔记打不开」，不像限流）。缓存热的时候这一轮返回 0，一次请求都不发；
   * 冷缓存下反链是**逐步收敛**的 —— 列表页本来就在后台补摘要，多来几次就齐了。
   */
  async backlinks(title: string): Promise<Array<{ id: string; title: string }>> {
    await hydrateExcerpts();
    const out: Array<{ id: string; title: string }> = [];
    for (const row of entryTitles(await tree())) {
      if (row.title === title) continue;
      const link = cache()[row.rel]?.l;
      if (link?.includes(title)) out.push({ id: encodeId(row.rel), title: row.title });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  },

  async get(id: string) {
    const rel = decodeId(id);
    // 打开笔记：有本地副本就先给副本，秒开；后台再对一次指纹（verify 这个必须开）
    const raw = await readOrNull(rel, true, true);
    if (raw === null) throw new StorageError('not_found', '笔记不存在', 404);
    // 页面（…/index.md）的标题是它所在的目录名
    const parsed = parseNote(raw, titleOf(rel), Date.now());
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
  /** 出现过哪些标签（侧栏用）。先补一次摘要缓存 —— 标签就是从那份缓存里来的，不额外发请求 */
  async tags(): Promise<Array<{ name: string; count: number }>> {
    // 把还没补过的补上：一次读回来的正文顺带解析出 tags，与列表摘要同一份缓存
    for (let round = 0; round < 20; round += 1) {
      if ((await hydrateExcerpts()) === 0) break;
    }
    const count = new Map<string, number>();
    for (const entry of allEntries(await tree())) {
      for (const tag of cachedTags(entry)) count.set(tag, (count.get(tag) ?? 0) + 1);
    }
    return [...count.entries()]
      .map(([name, n]) => ({ name, count: n }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  },

  async update(
    id: string,
    patch: { title?: string; content?: string; folder_id?: string | null; tags?: string[] },
  ) {
    const rel = decodeId(id);
    const raw = await readOrNull(rel);
    if (raw === null) throw new StorageError('not_found', '笔记不存在', 404);

    // 页面（…/index.md）在文件系统里是**一个目录**：改标题 = 重命名目录、换目录 = 移动目录。
    // folder_id 的语义两边一致 —— 都是「这篇笔记挂在哪个目录下」。
    const pageDir = pageDirOf(rel);
    const folderNow = pageDir === null ? parentOf(rel) : parentOf(pageDir);
    const parsed = parseNote(raw, titleOf(rel), Date.now());

    const title = patch.title !== undefined ? patch.title.trim() || '无标题笔记' : parsed.title;
    let body = patch.content !== undefined ? patch.content : parsed.body;
    const folderNext =
      patch.folder_id !== undefined ? (patch.folder_id ? decodeId(patch.folder_id) : '') : folderNow;

    let target = rel;
    const stem = sanitize(title);
    const currentStem = pageDir === null ? stemOf(lastSegment(rel)) : lastSegment(pageDir);
    if (folderNext !== folderNow || stem !== currentStem) {
      if (folderNext !== folderNow && folderNext) await getStorage().ensureDir(folderNext);
      if (pageDir !== null) {
        // 一次 MOVE 带走整棵子树：子笔记、子页面、附件全在目录里
        const targetDir = await uniqueRel(folderNext, stem, '', pageDir, true);
        if (targetDir !== pageDir) {
          await getStorage().move(pageDir, targetDir);
          target = `${targetDir}/index.md`;
          invalidateTree();
        }
      } else {
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
    }

    const meta: NoteMeta = {
      title,
      created: parsed.created,
      updated: Date.now(),
      tags: patch.tags ?? parsed.tags,
    };
    await getStorage().write(target, serializeNote(meta, body));

    const later = cache();
    delete later[rel];
    persistCache();

    // 改名：把别的笔记里指向旧名字的 `[[…]]` 一起改成新名字。
    // 放在**改名已经落盘之后**，所以这里失败也不会让笔记处于半改状态。
    if (title !== parsed.title) await propagateRename(parsed.title, title);

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

    // 页面：删一篇 = 删它**整个目录**（子笔记、子页面、附件都在里面），整棵进回收站
    const pageDir = pageDirOf(rel);
    if (pageDir !== null) {
      await foldersApi.trash(encodeId(pageDir));
      return { hard: false };
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
    return restoreNoteFile(decodeId(id));
  },
};

/* ------------------------------ 文件夹 API ------------------------------ */

export const foldersApi = {
  async list() {
    const { notes, dirs, pages } = await tree();

    const countByDir = new Map<string, number>();
    for (const note of notes) {
      const dir = parentOf(note.path);
      countByDir.set(dir, (countByDir.get(dir) ?? 0) + 1);
    }

    const items: FolderDTO[] = dirs.map((dir) => {
      const parent = parentOf(dir.path);
      const page = pages.get(dir.path);
      return {
        id: encodeId(dir.path),
        parent_id: parent ? encodeId(parent) : null,
        name: dir.name,
        created_at: dir.mtime ?? 0,
        updated_at: dir.mtime ?? 0,
        // 直系 .md 数；页面自己的 index.md 不算（它代表这个目录本身）
        note_count: countByDir.get(dir.path) ?? 0,
        // 目录里有 index.md → 这个目录是一个**页面**，给出那篇笔记的 id
        page_id: page ? encodeId(page.path) : null,
      };
    });
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    return { items };
  },

  async create(input: { name: string; parent_id?: string | null }) {
    const parent = input.parent_id ? decodeId(input.parent_id) : '';
    // 与 rename 同一套查重：撞名自动补「 2」后缀，不再静默复用既有目录
    // （mkdir 把 405 当成功，原来撞名会悄悄指向已有目录）
    const rel = await uniqueRel(parent, sanitize(input.name), '');
    await getStorage().mkdir(rel);
    invalidateTree();
    const parentFull = parentOf(rel);
    return {
      folder: {
        id: encodeId(rel),
        parent_id: parentFull ? encodeId(parentFull) : null,
        // 真实落盘的末段名（查重可能补过后缀），不能拿用户输入的原名糊弄调用方
        name: rel.slice(rel.lastIndexOf('/') + 1),
        created_at: Date.now(),
        updated_at: Date.now(),
        note_count: 0,
        // 刚建的目录一定是空的，不可能是页面
        page_id: null,
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
        // 改的是目录名，页面身份跟着目录走
        page_id: (await hasIndexFile(target)) ? encodeId(`${target}/index.md`) : null,
      } satisfies FolderDTO,
    };
  },

  /**
   * 把整个目录搬到另一个父目录下 —— 子目录、笔记、`.assets` 都跟着走。
   *
   * 与 rename 是同一段逻辑，只差目标父目录。搬家用 WebDAV 的 MOVE，**一个请求搬完整棵子树**
   * （服务器侧是集合的递归移动），所以不像 remove() 那样要逐个子项搬；
   * 本地索引由缓存层的 repath() 整体换前缀，笔记行的 folder、目录集合都会跟着改。
   *
   * 目标父目录必然已存在（要么是根、要么是列表里选中的文件夹），所以不 ensureDir。
   */
  async move(id: string, parentId: string | null) {
    const from = decodeId(id);
    if (!from) throw new StorageError('other', '根目录不能移动', 400);

    const to = parentId ? decodeId(parentId) : '';
    if (to === from) throw new StorageError('other', '不能移动到它自己里面', 400);
    // 防环：目标落在自己的子树里，搬过去等于把自己连根摘掉。
    // 这条必须在数据层挡（UI 里不列出子目录只是顺手，不能当唯一防线）。
    if (to.startsWith(`${from}/`)) {
      throw new StorageError('other', '不能移动到它自己的子目录里', 400);
    }

    const stem = from.slice(from.lastIndexOf('/') + 1);
    // exclude 传自己：目标就是当前父目录时，自己不该被算成「重名」
    const target = await uniqueRel(to, stem, '', from);
    if (target !== from) await getStorage().move(from, target);
    invalidateTree();

    const parent = parentOf(target);
    return {
      newPath: target,
      newFolderId: encodeId(target),
      folder: {
        id: encodeId(target),
        parent_id: parent ? encodeId(parent) : null,
        // 落盘的才是真名：撞名时查重会补「 2」后缀，不能拿原名糊弄调用方
        name: target.slice(target.lastIndexOf('/') + 1),
        created_at: Date.now(),
        updated_at: Date.now(),
        note_count: 0,
        page_id: (await hasIndexFile(target)) ? encodeId(`${target}/index.md`) : null,
      } satisfies FolderDTO,
    };
  },

  /** 只解散文件夹：里面内容逐个上移到父级，再删掉这个空目录 */
  async remove(id: string) {
    const rel = decodeId(id);
    const parent = parentOf(rel);
    const children = (await listDir(rel, true)).filter((entry) => !entry.name.startsWith('.'));

    await mapLimited(children, 3, async (child) => {
      const ext = child.isDirectory ? '' : '.md';
      const target = await uniqueRel(parent, stemOf(child.name), ext);
      await getStorage().move(child.path, target);
    });

    await getStorage().delete(rel);
    invalidateTree();
    return { moved_to: parent ? encodeId(parent) : null };
  },

  /**
   * 删除文件夹：**整棵子树作为一个整体**进 `.trash`。
   *
   * 一次 WebDAV MOVE 搬完整棵（服务端递归移动集合），所以不像解散那样要逐个子项搬。
   * 落点叫 `YYYYMMDD-HHMMSS_原名`：时间戳既是给人看的，也是回收站排序 / 30 天计时用的。
   * 原路径写进条目里的 `.donote-origin` —— 恢复时靠它回原位（目录名本身只有一个末段名，
   * 光看名字不知道它原来挂在谁下面）。
   */
  async trash(id: string) {
    const rel = decodeId(id);
    if (!rel) throw new StorageError('other', '根目录不能删除', 400);

    await getStorage().ensureDir(TRASH_DIR);
    const entry = await uniqueTrashEntry(`${stampName()}_${rel.slice(rel.lastIndexOf('/') + 1)}`);
    const at = `${TRASH_DIR}/${entry}`;

    await getStorage().move(rel, at);
    await getStorage().write(`${at}/${ORIGIN_FILE}`, rel);
    invalidateTree();
    return { entry, path: at };
  },
};

/* ------------------------------ 单篇恢复（笔记 / 文件夹条目共用） ------------------------------ */

/** 把 `.trash` 下的一个 .md 恢复回 frontmatter 记的原路径 */
async function restoreNoteFile(rel: string): Promise<{ note: NoteDTO }> {
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
}

/* ------------------------------ 回收站：顶层条目 + 树 ------------------------------ */

/**
 * 回收站里的东西按**顶层条目**组织：一次删除动作产生一个条目。
 *
 *   删一篇笔记 → `.trash/1791950000000-ab12-标题.md`        （既有方案，时间在 frontmatter）
 *   删一个文件夹 → `.trash/20261014-143022_框架笔记/`        （整棵子树，时间在条目名里）
 *                   框架笔记.md / 子笔记A.assets/ / 子笔记B/子笔记B.md
 *
 * 时间只有顶层条目有，下面的子项全都继承它 —— 30 天到期是**整条一起清**。
 * 单独恢复 / 单独彻底删除一个子项之后，剩下的子项仍然按原来的时间算（不重新计时）。
 */
const ORIGIN_FILE = '.donote-origin';

export type TrashKind = 'note' | 'folder';

export interface TrashChild {
  /** 相对所属顶层条目的路径，例如 `子笔记B/子笔记B.md` */
  rel: string;
  /** 相对同步根的路径，例如 `.trash/20261014-143022_框架/子笔记B/子笔记B.md` */
  path: string;
  kind: TrashKind;
  title: string;
  children: TrashChild[];
}

export interface TrashEntry {
  /** `.trash` 下的名字 */
  entry: string;
  /** 相对同步根的路径，即 `.trash/<entry>` */
  path: string;
  kind: TrashKind;
  title: string;
  /** 顶层条目的删除时间 */
  deletedAt: number;
  /** 恢复后回到哪（相对同步根） */
  origin: string;
  children: TrashChild[];
}

/** `YYYYMMDD-HHMMSS`，本地时间。给用户看的，也是文件夹条目的时间来源 */
function stampName(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 从文件夹条目名里读回时间。认不出来（老条目 / 手改名）就用目录自身的 mtime */
function parseStamp(name: string): number | null {
  const hit = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_/.exec(name);
  if (!hit) return null;
  const at = new Date(
    Number(hit[1]),
    Number(hit[2]) - 1,
    Number(hit[3]),
    Number(hit[4]),
    Number(hit[5]),
    Number(hit[6]),
  ).getTime();
  return Number.isFinite(at) ? at : null;
}

/** 同一秒删两个同名文件夹时不覆盖：补 ` 2`、` 3`… */
async function uniqueTrashEntry(base: string): Promise<string> {
  /*
   * 🔴 这里**必须** fresh，别为了省一次 PROPFIND 改成走本地索引。
   *
   * 这份列表是用来「决定叫什么名字」的，而本地索引更新有 60 秒 TTL：同一秒内第二次
   * 删除看不到上一次刚建出来的条目。后果按类型分两种，都不能接受 ——
   *   文件夹：`move` 带 Overwrite:F，撞上就是 412，用户看到「删除失败」；
   *   笔记：回收站那份是 PUT 写进去的，撞上**静默覆盖**掉早先删的那一篇（不可逆）。
   * 名字里的时间戳只到秒，挡不住这件事。删一次的代价是 3.2 秒排队，丢一条笔记不是。
   */
  const taken = new Set((await listDir(TRASH_DIR, true)).map((entry) => entry.name));
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} ${n}`;
    n += 1;
  }
  return candidate;
}

function lastSegment(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** 读子项（跳过点开头的与 .assets —— 附件跟着它那篇笔记走，不单独成节点） */
async function readTrashChildren(dir: string, prefix = '', depth = 0): Promise<TrashChild[]> {
  if (depth > 6) return [];
  const entries = (await listDir(dir)).filter((entry) => !entry.name.startsWith('.'));
  const out: TrashChild[] = [];

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (isAssetsDir(entry.name)) continue;
      out.push({
        rel,
        path: entry.path,
        kind: 'folder',
        title: entry.name,
        children: await readTrashChildren(entry.path, rel, depth + 1),
      });
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push({ rel, path: entry.path, kind: 'note', title: stemOf(entry.name), children: [] });
    }
  }

  out.sort((a, b) =>
    a.kind === b.kind ? a.title.localeCompare(b.title, 'zh') : a.kind === 'folder' ? -1 : 1,
  );
  return out;
}

/**
 * 列回收站顶层条目（新的在前）。笔记条目的标题 / 时间取自 frontmatter ——
 * 与既有的 `list({trash:true})` 同一口径，两个视图不会各说各话。
 */
export async function listTrashEntries(): Promise<TrashEntry[]> {
  let entries: DirEntry[];
  try {
    entries = await listDir(TRASH_DIR);
  } catch {
    return [];
  }

  const rows = await mapLimited(entries, 4, async (entry): Promise<TrashEntry | null> => {
    if (entry.name.startsWith('.')) return null;

    if (entry.isDirectory) {
      // 笔记的附件目录也躺在 .trash 里（`<前缀>.assets`），它不是独立条目
      if (isAssetsDir(entry.name)) return null;
      // preferCache：软删那一刻就写过一份副本，这里不必再 GET 一次（回收站条目多时省下的很明显）
      const origin = (await readOrNull(`${entry.path}/${ORIGIN_FILE}`, true))?.trim();
      const title = entry.name.replace(/^\d{8}-\d{6}_/, '') || entry.name;
      return {
        entry: entry.name,
        path: entry.path,
        kind: 'folder',
        title,
        deletedAt: parseStamp(entry.name) ?? entry.mtime ?? 0,
        origin: origin || title,
        children: await readTrashChildren(entry.path),
      };
    }

    if (!entry.name.toLowerCase().endsWith('.md')) return null;
    const raw = await readOrNull(entry.path, true);
    const parsed = raw ? parseNote(raw, baseName(entry.path), entry.mtime ?? 0) : null;
    return {
      entry: entry.name,
      path: entry.path,
      kind: 'note',
      title: parsed?.title ?? baseName(entry.path),
      deletedAt: parsed?.deleted_at ?? entry.mtime ?? 0,
      origin: parsed?.deleted_from ?? baseName(entry.path),
      children: [],
    };
  });

  return rows.filter((row): row is TrashEntry => row !== null).sort((a, b) => b.deletedAt - a.deletedAt);
}

/**
 * 一篇被删的笔记是否带着有内容的附件目录。
 *
 * 单独恢复这样的笔记要**先问一句**：用户不一定知道附件会跟着回去。
 * 只看「目录在不在、里面有没有东西」，不判断附件有没有被正文引用 —— 那要读正文，
 * 而「.assets 里躺着一张图」本身就是「这一篇带附件」最直接的证据。
 */
export async function trashNoteHasAssets(entryPath: string): Promise<boolean> {
  const dir = trashAssetsPath(entryPath);
  try {
    return (await listDir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function restoreFolderEntry(entry: TrashEntry): Promise<void> {
  const target = entry.origin;
  // 与单篇恢复一个口径：原位置被占了就放弃，不自动改名也不落到别处
  if (await pathExists(target)) {
    throw new StorageError('conflict', `「${lastSegment(target)}」已存在，恢复已放弃`, 409);
  }
  const parent = parentOf(target);
  if (parent) await getStorage().ensureDir(parent);

  await getStorage().move(entry.path, target);
  // 条目里的记账文件不该留在用户目录里；删不掉也不影响内容
  try {
    await getStorage().delete(`${target}/${ORIGIN_FILE}`);
  } catch {
    /* 点开头的文件不进任何列表，留着也无害 */
  }
  invalidateTree();
}

/** 恢复整条（笔记 → 回 frontmatter 记的原路径；文件夹 → 整棵回原位） */
export async function restoreTrashEntry(entry: TrashEntry): Promise<void> {
  if (entry.kind === 'note') {
    await restoreNoteFile(entry.path);
    return;
  }
  await restoreFolderEntry(entry);
}

/**
 * 恢复顶层条目里的**单个子项**。
 *
 * 原父目录还在就回原处，不在（多半是它所属的文件夹还在回收站里）就落到根 —— 这是任务书
 * 定的规则，不自动造父目录。笔记带着同名 `.assets` 一起走。
 * 恢复出去的这一项离开回收站，时间约束随之解除。
 */
export async function restoreTrashChild(entry: TrashEntry, child: TrashChild): Promise<void> {
  const from = child.path;
  const wanted = `${entry.origin}/${child.rel}`;
  const parent = parentOf(wanted);
  const target = parent && (await pathExists(parent)) ? wanted : lastSegment(wanted);

  if (await pathExists(target)) {
    throw new StorageError('conflict', `「${lastSegment(target)}」已存在，恢复已放弃`, 409);
  }
  const targetDir = parentOf(target);
  if (targetDir) await getStorage().ensureDir(targetDir);

  await getStorage().move(from, target);

  if (child.kind === 'note') {
    try {
      await moveAssets(getAssetsDirPath(from), getAssetsDirPath(target));
    } catch (error) {
      await getStorage().delete(target);
      const reason = error instanceof Error ? error.message : String(error);
      throw new StorageError('other', `附件恢复失败，已回滚：${reason}`, 0);
    }
  }
  invalidateTree();
}

/** 彻底删除整条（文件夹条目连同整棵子树） */
export async function purgeTrashEntry(entry: TrashEntry): Promise<void> {
  await getStorage().delete(entry.path);
  if (entry.kind === 'note') await getStorage().delete(trashAssetsPath(entry.path));
  invalidateTree();
}

/** 彻底删除顶层条目里的单个子项 */
export async function purgeTrashChild(child: TrashChild): Promise<void> {
  await getStorage().delete(child.path);
  if (child.kind === 'note') await getStorage().delete(trashAssetsPath(child.path));
  invalidateTree();
}

/**
 * 按顶层条目的 deletedAt 清掉到期的东西（设置页的「回收站自动清理」）。
 *
 * 静默：能删几条删几条，被限流（503）就停下 —— 下一次触发时接着清，不当成错误报给用户。
 * 一次清多项之间留间隔，别把免费版的 600 请求 / 30 分钟撞满。
 *
 * `known` = 调用方**手上已经有一份**回收站列表（回收站页刚列完）。
 * 传进来就别再列一遍：列一次每条约 1 个请求，接口是 3.2 秒一个，白花半分钟。
 */
export async function purgeExpiredTrash(days: number, known?: TrashEntry[]): Promise<number> {
  if (!(days > 0)) return 0;
  const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
  const expired = (known ?? (await listTrashEntries())).filter((entry) => entry.deletedAt <= deadline);

  let done = 0;
  for (const entry of expired) {
    try {
      await purgeTrashEntry(entry);
      done += 1;
    } catch (error) {
      // 限流（503 BlockedTemporarily）停下等下次；其它错误也不打断后续条目
      if (error instanceof StorageError && error.status === 503) break;
    }
    if (done) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return done;
}
