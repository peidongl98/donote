/**
 * 带本地缓存的存储装饰器。
 *
 * 主存储仍然是用户自己的网盘 —— 这一层只做三件事：
 *   1. 读：列表和正文都先给本地（秒开），后台再校验；网断了直接用本地，不往上抛错。
 *   2. 写：写云端成功就顺手更新副本；网断了写副本并标 dirty，等恢复联网再推。
 *   3. 列目录：本地已有这一层就直接返回，同时后台发一次 PROPFIND 对账。
 *
 * 「本地优先 + 后台校验」的判据：
 *   - 列表 / 打开笔记：有副本就先给副本，请求全部挪到后台，界面不等网络。
 *   - 校验用文件的 etag（坚果云给文件发真 etag，且内容变就变）；
 *     集合（目录）没有 etag，退回 getlastmodified，按秒比较。
 *   - 同一目录在 LIST_TTL_MS 内不重复校验 —— 坚果云 30 分钟只有 600 次配额。
 *   - 校验真的发现差异才 notifyData()，界面据此重取一次数据；没差异就静默。
 *
 * 刻意不做的事：
 *   - 不接管 move / delete / mkdir 的云端语义。这些是结构变更，半成功比失败更难收拾，
 *     断网时直接抛错，交给界面提示。本地索引跟着一起改，但那只是索引，不是事实来源。
 *   - 不承诺完全离线。只有「本机读过的」才在缓存里。
 *   - 不做写队列。「先写本地再后台推」是另一个量级的改动，本批次不碰。
 */
import type {
  BatchOperation,
  BatchResult,
  ConnectResult,
  DirEntry,
  FileStat,
  ListOptions,
  ReadOptions,
  StorageAdapter,
  StorageConfig,
  StorageKind,
  WriteContent,
  WriteResult,
} from '@/services/storage';
import { StorageError } from '@/services/storage';
import { inBackoff } from '@/storage/backoff';
import type { CacheStore } from './store';
import {
  emptyMeta,
  loadFolders,
  loadMeta,
  noteFile,
  saveFolders,
  saveMeta,
  type CacheMeta,
  type NoteRow,
} from './meta';

function parentOf(rel: string): string {
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : rel.slice(0, at);
}

/** 去掉 .md 后缀的末段 */
function stemOf(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * 目录里的 index.md —— 它代表**那个目录**（一个页面），标题要取目录名而不是「index」。
 * ⚠️ 同步根下的 `index.md` 不算（rel 里必须带目录前缀），与数据层的 isPageFile 同一口径。
 */
function isPageIndex(entry: DirEntry): boolean {
  return entry.name.toLowerCase() === 'index.md' && entry.path.includes('/');
}

function lastSegment(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** 请求根本没发出去 = 离线。只有这一类错误才有资格走缓存兜底 */
function isOffline(error: unknown): boolean {
  return error instanceof StorageError && error.code === 'unreachable';
}

/** 同一目录多久不重复校验。太短会把限流额度烧在反复切页上；跨进程保留，重开应用也算数 */
const LIST_TTL_MS = 60_000;
/** 后台校验的并行度。出网已被全局闸门压成串行，这里的 2 只是不让队列一条条空等 */
const CHECK_CONCURRENCY = 2;
/** 两次后台校验之间的最小间隔 */
const CHECK_GAP_MS = 150;

/** 服务端 mtime 只到秒，本地写入给的是毫秒，比较前一律压到秒 */
function sameSecond(a: number, b: number): boolean {
  return a !== 0 && b !== 0 && Math.floor(a / 1000) === Math.floor(b / 1000);
}

export class CachedStorage implements StorageAdapter {
  get kind(): StorageKind {
    return this.inner.kind;
  }

  private meta: CacheMeta = emptyMeta('');
  private folders = new Set<string>();
  /** 已经成功列过的目录。只有列过，才敢拿它的结果删本地多出来的条目 */
  private listed = new Set<string>();
  private ready: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dataTimer: ReturnType<typeof setTimeout> | null = null;
  private offline = false;
  private inflight = new Set<string>();
  /** 每个目录上次校验完成的时刻 */
  private checkedAt = new Map<string, number>();
  /** 后台校验队列（去重 + 限并发） */
  private queue: string[] = [];
  private queued = new Set<string>();
  private checking = 0;
  private netHandler: (() => void) | null = null;
  private lifeHandler: (() => void) | null = null;

  constructor(
    private inner: StorageAdapter,
    private store: CacheStore,
    private root: string,
  ) {
    this.meta = emptyMeta(root);
    this.ready = this.hydrate().then(() => {
      this.watchNetwork();
      this.watchLifecycle();
    });
  }

  private async hydrate(): Promise<void> {
    this.meta = await loadMeta(this.store, this.root);
    const folders = await loadFolders(this.store);
    for (const folder of folders.items) this.folders.add(folder);
    for (const folder of folders.listed) this.listed.add(folder);
    for (const [dir, at] of Object.entries(folders.checked)) this.checkedAt.set(dir, at);
  }

  /* ------------------------------ 元数据维护 ------------------------------ */

  private row(rel: string): NoteRow {
    let row = this.meta.notes[rel];
    if (!row) {
      row = { title: '', folder: parentOf(rel), mtime: 0, etag: '', cached: false, dirty: false };
      this.meta.notes[rel] = row;
    }
    return row;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, 500);
  }

  /**
   * 页面要走（跳转 / 关闭）时，把还压在防抖里的索引落下去。
   *
   * `scheduleSave()` 排的是 500ms 后的写入，定时器随页面一起销毁 —— 这一笔就丢了。
   * 丢的后果不小：刚写完的笔记已经进了内存索引，但没落盘；下一页读到的是**旧索引**，
   * 而目录级 60 秒 TTL 又拦住了重新校验，于是列表里看不到那篇笔记。
   * （实测：创建笔记后立刻重载，不修这一笔就稳定复现空列表。）
   */
  private flushIndex(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.persist();
  }

  /** 立刻落盘（退出前或关键节点用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dataTimer) {
      clearTimeout(this.dataTimer);
      this.dataTimer = null;
    }
    this.queue = [];
    this.queued.clear();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await saveMeta(this.store, this.meta);
    await saveFolders(this.store, [...this.folders], [...this.listed], this.checkedAt);
  }

  /** 「立即同步」用：把校验时间全部作废，下一轮把整棵树重新对一遍账 */
  invalidateChecks(): void {
    this.checkedAt.clear();
    this.queue = [];
    this.queued.clear();
  }

  private async readCache(rel: string): Promise<string | null> {
    try {
      return await this.store.read(noteFile(rel));
    } catch {
      return null;
    }
  }

  private async writeCache(rel: string, text: string): Promise<void> {
    try {
      await this.store.write(noteFile(rel), text);
      const row = this.row(rel);
      const first = !row.cached;
      row.cached = true;
      this.scheduleSave();
      // 只在「从没缓存变成有缓存」时通知，列表里那篇要从浅灰变回正常色
      if (first) this.notify();
    } catch {
      // 缓存写不进去不影响正常读写
    }
  }

  /* ------------------------------ 连接状态 ------------------------------ */

  /** 只在状态真的翻转时通知，免得每次读都抖一下界面 */
  private markOnline(): void {
    if (!this.offline) return;
    this.offline = false;
    this.notify();
  }

  private markOffline(): void {
    if (this.offline) return;
    this.offline = true;
    this.notify();
  }

  isOffline(): boolean {
    return this.offline;
  }

  /** 有本地改动还没推上云的笔记数 */
  dirtyCount(): number {
    return Object.values(this.meta.notes).filter((row) => row.dirty).length;
  }

  /** 某篇是否已有本地副本（列表里用来决定要不要画成浅灰） */
  hasCopy(rel: string): boolean {
    return this.meta.notes[rel]?.cached === true;
  }

  /** 直接读本地副本，不碰网络。冲突处理要看本地版本时用 */
  localCopy(rel: string): Promise<string | null> {
    return this.readCache(rel);
  }

  /**
   * 浏览器给的断网信号。有它，顶栏能在**不花一次请求**的前提下立刻转灰 ——
   * 否则「刚断网但目录还在 TTL 内」这段窗口里，界面只能一直显示已连接。
   * 网络回来时只作废校验时刻，不动状态点：绿色仍然只表示「请求真的成功过」。
   */
  private watchNetwork(): void {
    if (typeof window === 'undefined' || this.netHandler) return;
    this.netHandler = (): void => {
      if (navigator.onLine) this.invalidateChecks();
      else this.markOffline();
    };
    window.addEventListener('online', this.netHandler);
    window.addEventListener('offline', this.netHandler);
    if (!navigator.onLine) this.markOffline();
  }

  private watchLifecycle(): void {
    if (typeof window === 'undefined' || this.lifeHandler) return;
    this.lifeHandler = (): void => this.flushIndex();
    window.addEventListener('pagehide', this.lifeHandler);
  }
  /** 冲突时选「用云端」：把云端正文覆盖到副本上，清掉 dirty */
  async acceptRemote(rel: string): Promise<void> {
    const text = await this.inner.read(rel);
    await this.writeCache(rel, text);
    const stat = await this.inner.stat(rel);
    const row = this.row(rel);
    row.mtime = stat.mtime;
    row.etag = stat.etag;
    row.dirty = false;
    this.scheduleSave();
  }

  /** 冲突时选「保留本地」：把副本推上去，覆盖云端 */
  async keepLocal(rel: string): Promise<void> {
    const body = await this.readCache(rel);
    if (body === null) return;
    await this.write(rel, body);
  }

  /** 已缓存正文的笔记数 */
  cachedCount(): number {
    return Object.values(this.meta.notes).filter((row) => row.cached).length;
  }

  noteRows(): Readonly<Record<string, NoteRow>> {
    return this.meta.notes;
  }

  /* ------------------------------ 变更通知 ------------------------------ */

  private listeners = new Set<() => void>();
  private dataListeners = new Set<() => void>();

  /** 订阅「离线态 / dirty 数」变化，给状态点用。返回退订函数 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * 订阅「云端数据变了」。只有后台校验真的对出差异时才发 ——
   * 状态点的翻转不走这条，否则视图会被每次读操作引起的状态抖动带着刷。
   */
  subscribeData(fn: () => void): () => void {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  /**
   * 一次遍历会给好几个目录对账，每个目录都可能报「变了」。
   * 合并成一次通知：界面只需要知道「现在该重取一次数据」，不需要知道变了几处。
   */
  private notifyData(): void {
    if (this.dataTimer) return;
    this.dataTimer = setTimeout(() => {
      this.dataTimer = null;
      for (const fn of this.dataListeners) fn();
    }, 200);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  async connect(config: StorageConfig): Promise<ConnectResult> {
    const result = await this.inner.connect(config);
    this.markOnline();
    return result;
  }

  adopt(config: StorageConfig): void {
    this.inner.adopt(config);
  }

  async disconnect(): Promise<void> {
    await this.flush();
    if (this.netHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.netHandler);
      window.removeEventListener('offline', this.netHandler);
      this.netHandler = null;
    }
    await this.inner.disconnect();
  }

  async testConnection(): Promise<boolean> {
    const ok = await this.inner.testConnection();
    if (ok) this.markOnline();
    else this.markOffline();
    return ok;
  }

  /* ------------------------------ 读 ------------------------------ */

  /** 读原始字节：缓存层不掺和（图片是二进制，缓存只存文本），直接透传。 */
  readBytes(path: string): Promise<ArrayBuffer> {
    return this.inner.readBytes(path);
  }

  async read(path: string, options?: ReadOptions): Promise<string> {
    await this.ready;

    if (options?.preferCache) {
      const cached = await this.readCache(path);
      if (cached !== null) {
        /*
         * 只有调用方明确要"最新"时才在后台对指纹（见 ReadOptions.verify）。
         * 列表补齐这类批量读别校验：每条一次 stat，几十条就把限流额度排满，
         * 而它们要的只是标题 / 时间，旧一点无所谓。
         */
        if (options.verify) void this.revalidate(path);
        return cached;
      }
    }

    try {
      const text = await this.inner.read(path);
      await this.writeCache(path, text);
      this.markOnline();
      return text;
    } catch (error) {
      const cached = await this.readCache(path);
      if (cached !== null && isOffline(error)) {
        this.markOffline();
        return cached;
      }
      throw error;
    }
  }

  /**
   * 后台校验一篇笔记：指纹不一致就重拉全文覆盖副本，并把「数据变了」发给界面。
   * 指纹优先用 etag（坚果云给文件发真 etag，内容变就变）；没有 etag 时退回 mtime，
   * 按秒比较 —— 本地刚写完的 mtime 是 Date.now() 毫秒值，只有压到秒才对得上服务端。
   */
  private async revalidate(path: string): Promise<void> {
    if (this.inflight.has(path)) return;
    this.inflight.add(path);
    try {
      const stat = await this.inner.stat(path);
      const row = this.row(path);
      this.markOnline();
      const same = row.etag && stat.etag ? row.etag === stat.etag : sameSecond(row.mtime, stat.mtime);
      // 顺手把本地记的指纹校正成服务端的值（本地写入留下的是毫秒值）
      row.mtime = stat.mtime;
      row.etag = stat.etag;
      if (same) {
        this.scheduleSave();
        return;
      }
      const text = await this.inner.read(path);
      await this.writeCache(path, text);
      this.notifyData();
    } catch (error) {
      if (isOffline(error)) this.markOffline();
      // 限流（503 / 429）不在这里处理：退避档位记在出网层，下一轮 enqueue 会读到
    } finally {
      this.inflight.delete(path);
    }
  }

  /* ------------------------------ 写 ------------------------------ */

  async write(path: string, content: WriteContent, etag?: string): Promise<WriteResult> {
    await this.ready;
    try {
      const result = await this.inner.write(path, content, etag);
      if (typeof content === 'string') {
        await this.writeCache(path, content);
        const row = this.row(path);
        row.dirty = false;
        // 本地刚写过，手上的 etag 已经不作数：清掉，等下一轮 PROPFIND 领新的
        row.etag = '';
        if (result.mtime) row.mtime = result.mtime;
        this.scheduleSave();
      }
      this.markOnline();
      return result;
    } catch (error) {
      // 断网时把正文留在本地，标 dirty，恢复联网后再推
      if (typeof content === 'string' && isOffline(error)) {
        const now = Date.now();
        await this.writeCache(path, content);
        const row = this.row(path);
        row.dirty = true;
        row.mtime = now;
        this.scheduleSave();
        this.markOffline();
        return { etag: '', mtime: now };
      }
      throw error;
    }
  }

  /* ------------------------------ 列目录 / 状态 ------------------------------ */

  /**
   * 列目录：本地已经有这一层的快照就直接返回，同时把校验排进后台队列。
   * 只有「从没列过这一层」才等网络 —— 那种情况下本地确实不知道有什么。
   *
   * `fresh` 跳过缓存直接问云端：调用方要拿这份列表决定名字或是否覆盖时（重名检查、搬运避让），
   * 用旧列表等于没查。
   */
  async list(path: string, options?: ListOptions): Promise<DirEntry[]> {
    await this.ready;
    if (options?.fresh) return this.fetchDir(path);
    const cached = this.cachedEntries(path);
    if (cached.length || this.listed.has(path)) {
      this.enqueue(path);
      return cached;
    }
    try {
      return await this.fetchDir(path);
    } catch (error) {
      if (isOffline(error)) this.markOffline();
      throw error;
    }
  }

  /** 真去云端列一次并写进索引 */
  private async fetchDir(path: string): Promise<DirEntry[]> {
    const entries = await this.inner.list(path);
    const changed = this.reconcile(path, entries);
    this.checkedAt.set(path, Date.now());
    this.markOnline();
    if (changed) this.notifyData();
    return entries;
  }

  /* ---------- 后台校验队列：限并发 + 冷却，别把限流额度撞穿 ---------- */

  private enqueue(path: string): void {
    if (this.queued.has(path)) return;
    // 正在退避（撞过 503 / 429）就一个都别发 —— 退避档位是所有请求源共用的
    if (inBackoff()) return;
    const last = this.checkedAt.get(path) ?? 0;
    if (Date.now() - last < LIST_TTL_MS) return;
    this.queued.add(path);
    this.queue.push(path);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.checking < CHECK_CONCURRENCY && this.queue.length) {
      const path = this.queue.shift() as string;
      this.checking++;
      try {
        await this.fetchDir(path);
      } catch (error) {
        if (isOffline(error)) this.markOffline();
        // 被限流就把手上的队列清掉，别跟服务端对着干（退避档位由出网层记）
        else if (inBackoff()) this.queue = [];
      } finally {
        this.checking--;
        this.queued.delete(path);
      }
      await new Promise((resolve) => setTimeout(resolve, CHECK_GAP_MS));
    }
  }

  /**
   * 用一次 PROPFIND 的结果给这一层的索引对账：
   *   新出现 / 指纹变了的 → 写进索引；
   *   云端已经没有的 → 删掉索引条目（只有「列过这一层」才敢删，见 listed）。
   * 返回索引是否真的变了 —— 变了才通知界面，没变就静默。
   */
  private reconcile(dir: string, entries: DirEntry[]): boolean {
    let changed = false;
    const seen = new Set<string>();

    for (const entry of entries) {
      seen.add(entry.path);
      if (entry.isDirectory) {
        if (!this.folders.has(entry.path)) {
          this.folders.add(entry.path);
          changed = true;
        }
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const row = this.row(entry.path);
      const mtime = entry.mtime ?? 0;
      const etag = entry.etag ?? '';
      if (row.mtime !== mtime || row.etag !== etag) {
        // 只更新指纹，不删本地副本 —— 断网时旧副本比没有强
        row.mtime = mtime;
        row.etag = etag;
        changed = true;
      }
      const folder = parentOf(entry.path);
      if (row.folder !== folder) {
        row.folder = folder;
        changed = true;
      }
      if (!row.title) {
        row.title = isPageIndex(entry) ? lastSegment(folder) : stemOf(entry.name);
        changed = true;
      }
    }

    if (this.listed.has(dir)) {
      const prefix = dir ? `${dir}/` : '';
      const directChild = (rel: string): boolean => {
        if (!rel.startsWith(prefix)) return false;
        const rest = rel.slice(prefix.length);
        return Boolean(rest) && !rest.includes('/');
      };
      for (const rel of Object.keys(this.meta.notes)) {
        if (directChild(rel) && !seen.has(rel)) {
          // 云端已经没有这条了：索引条目和**本地副本**一起清。
          // 以前只删索引、把副本留着（指望断网时还能看到旧内容），代价是回归测试往真网盘写的
          // 夹具在云端删掉之后，本地缓存里永远留一份既不在索引、界面上也看不见的孤儿
          // （实测积了 9 个）。删除只发生在「列过这一层」的直系子项上（见上面的 listed 守卫），
          // 所以一次不完整的响应不会误伤别处。
          if (this.meta.notes[rel].cached) void this.store.remove(noteFile(rel));
          delete this.meta.notes[rel];
          changed = true;
        }
      }
      for (const folder of [...this.folders]) {
        if (directChild(folder) && !seen.has(folder)) {
          this.folders.delete(folder);
          // 目录要整棵清，否则留下一个空壳
          void this.store.remove(noteFile(folder));
          changed = true;
        }
      }
    }

    this.listed.add(dir);
    if (changed) this.scheduleSave();
    return changed;
  }

  /** 用本地索引把某一层的目录列出来 */
  private cachedEntries(dir: string): DirEntry[] {
    const prefix = dir ? `${dir}/` : '';
    const out: DirEntry[] = [];

    for (const rel of Object.keys(this.meta.notes)) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      const row = this.meta.notes[rel];
      out.push({ name: rest, path: rel, isDirectory: false, mtime: row.mtime, etag: row.etag });
    }

    for (const folder of this.folders) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      out.push({ name: rest, path: folder, isDirectory: true });
    }

    return out;
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const stat = await this.inner.stat(path);
      const row = this.row(path);
      row.mtime = stat.mtime;
      row.etag = stat.etag;
      this.scheduleSave();
      this.markOnline();
      return stat;
    } catch (error) {
      if (isOffline(error)) {
        const row = this.meta.notes[path];
        if (row) {
          this.markOffline();
          return { path, size: 0, mtime: row.mtime, isDirectory: false, etag: row.etag };
        }
      }
      throw error;
    }
  }

  /* ------------------------------ 结构变更（不离线兜底） ------------------------------ */

  async delete(path: string): Promise<void> {
    await this.inner.delete(path);
    await this.forget(path);
  }

  /**
   * 从本地索引里摘掉一个条目及其整棵子树。
   * 删目录时里面的东西会跟着在云端消失，索引必须一起清，否则列表会留下幽灵条目。
   */
  private async forget(path: string): Promise<void> {
    const prefix = `${path}/`;
    const inSubtree = (rel: string): boolean => rel === path || rel.startsWith(prefix);

    await this.forgetCopy(path);
    for (const rel of Object.keys(this.meta.notes)) {
      if (rel === path || !rel.startsWith(prefix)) continue;
      await this.forgetCopy(rel);
      delete this.meta.notes[rel];
    }
    delete this.meta.notes[path];
    for (const dir of [...this.folders]) if (inSubtree(dir)) this.folders.delete(dir);
    for (const dir of [...this.listed]) if (inSubtree(dir)) this.listed.delete(dir);

    // 父目录的结构变了，让它下一轮重新对账
    this.checkedAt.delete(parentOf(path));
    this.scheduleSave();
  }

  private async forgetCopy(rel: string): Promise<void> {
    try {
      await this.store.remove(noteFile(rel));
    } catch {
      // 缓存删不掉不影响云端已经删掉的事实
    }
  }

  async move(from: string, to: string): Promise<void> {
    await this.inner.move(from, to);
    await this.repath(from, to);
    this.scheduleSave();
  }

  /**
   * 把 from 及其整棵子树在本地索引里改写成 to —— 改名就是移动的特例。
   * 笔记行、目录集合、已列过的目录、以及已经落盘的正文副本都要跟着走，
   * 否则缓存优先后列表会同时显示新旧两个位置。
   */
  private async repath(from: string, to: string): Promise<void> {
    const fromPrefix = `${from}/`;
    const inSubtree = (rel: string): boolean => rel === from || rel.startsWith(fromPrefix);

    for (const rel of Object.keys(this.meta.notes)) {
      if (!inSubtree(rel)) continue;
      const next = to + rel.slice(from.length);
      const row = this.meta.notes[rel];
      delete this.meta.notes[rel];
      row.folder = parentOf(next);
      this.meta.notes[next] = row;
      if (!row.cached) continue;
      try {
        const body = await this.store.read(noteFile(rel));
        if (body !== null) {
          await this.store.write(noteFile(next), body);
          await this.store.remove(noteFile(rel));
        }
      } catch {
        // 副本搬不过去下次读云端补上
      }
    }

    for (const set of [this.folders, this.listed]) {
      for (const dir of [...set]) {
        if (!inSubtree(dir)) continue;
        set.delete(dir);
        set.add(to + dir.slice(from.length));
      }
    }

    this.checkedAt.delete(parentOf(from));
    this.checkedAt.delete(parentOf(to));
  }

  async mkdir(path: string): Promise<void> {
    await this.inner.mkdir(path);
    if (path && !this.folders.has(path)) {
      this.folders.add(path);
      this.scheduleSave();
    }
  }

  async ensureDir(path: string): Promise<void> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    /*
     * 本地索引已经知道这层目录在（列过根目录就会带上 .trash），就别再 MKCOL 一遍。
     * 软删每一篇笔记、删每一个文件夹都会 ensureDir('.trash') —— 白花的那一次
     * 是要排队的（闸门一节 3.2 秒），删除因此稳定慢一拍。
     * 不知道在不在就照旧发请求：MKCOL 对已存在的目录返回 405，当成功处理。
     */
    if (clean && this.folders.has(clean)) return;
    await this.inner.ensureDir(path);
    if (clean) {
      let acc = '';
      for (const seg of clean.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${seg}` : seg;
        this.folders.add(acc);
      }
      this.scheduleSave();
    }
  }

  async batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    const results = await this.inner.batch(operations);
    results.forEach((result, index) => {
      const op = operations[index];
      if (!result.ok || op.type !== 'write' || typeof op.content !== 'string') return;
      void this.writeCache(op.path, op.content);
    });
    return results;
  }
}
