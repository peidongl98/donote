/**
 * 带本地缓存的存储装饰器。
 *
 * 主存储仍然是用户自己的网盘 —— 这一层只做三件事：
 *   1. 读：打开笔记时先给本地副本（秒开），同时在后台比对 etag 把过期副本换掉；
 *      网断了就直接用副本，不再往上抛错。
 *   2. 写：写云端成功就顺手更新副本；网断了写副本并标 dirty，等恢复联网再推。
 *   3. 列目录：网断了用 meta.json 里记的结构顶一下，让列表还能显示。
 *
 * 刻意不做的事：
 *   - 不接管 move / delete / mkdir。这些是结构变更，半成功比失败更难收拾，
 *     断网时直接抛错，交给界面提示。
 *   - 不承诺完全离线。只有「本机读过的」才在缓存里。
 */
import type {
  BatchOperation,
  BatchResult,
  ConnectResult,
  DirEntry,
  FileStat,
  ReadOptions,
  StorageAdapter,
  StorageConfig,
  StorageKind,
  WriteContent,
  WriteResult,
} from '@/services/storage';
import { StorageError } from '@/services/storage';
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

/** 请求根本没发出去 = 离线。只有这一类错误才有资格走缓存兜底 */
function isOffline(error: unknown): boolean {
  return error instanceof StorageError && error.code === 'unreachable';
}

export class CachedStorage implements StorageAdapter {
  get kind(): StorageKind {
    return this.inner.kind;
  }

  private meta: CacheMeta = emptyMeta('');
  private folders = new Set<string>();
  private ready: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private offline = false;
  private inflight = new Set<string>();

  constructor(
    private inner: StorageAdapter,
    private store: CacheStore,
    private root: string,
  ) {
    this.meta = emptyMeta(root);
    this.ready = this.hydrate();
  }

  private async hydrate(): Promise<void> {
    this.meta = await loadMeta(this.store, this.root);
    for (const folder of await loadFolders(this.store)) this.folders.add(folder);
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
      void saveMeta(this.store, this.meta);
      void saveFolders(this.store, [...this.folders]);
    }, 500);
  }

  /** 立刻落盘（退出前或关键节点用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await saveMeta(this.store, this.meta);
    await saveFolders(this.store, [...this.folders]);
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

  private markOnline(): void {
    this.offline = false;
    this.notify();
  }

  private markOffline(): void {
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

  /** 订阅「离线态 / dirty 数」变化，给状态点用。返回退订函数 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
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
    await this.inner.disconnect();
  }

  async testConnection(): Promise<boolean> {
    const ok = await this.inner.testConnection();
    if (ok) this.markOnline();
    else this.markOffline();
    return ok;
  }

  /* ------------------------------ 读 ------------------------------ */

  async read(path: string, options?: ReadOptions): Promise<string> {
    await this.ready;

    if (options?.preferCache) {
      const cached = await this.readCache(path);
      if (cached !== null) {
        // 先给副本，再在后台对一次内容指纹；不一致就换掉副本，下次打开就是新的
        void this.revalidate(path);
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

  /** 后台校验：etag（服务端不给就退回 mtime）不一致时重拉全文覆盖副本 */
  private async revalidate(path: string): Promise<void> {
    if (this.inflight.has(path)) return;
    this.inflight.add(path);
    try {
      const stat = await this.inner.stat(path);
      const row = this.row(path);
      this.markOnline();
      // 服务端给 etag 就用 etag，不给就退回 mtime
      const unchanged = row.etag ? row.etag === stat.etag : row.mtime === stat.mtime;
      if (unchanged) return;
      const text = await this.inner.read(path);
      row.etag = stat.etag;
      row.mtime = stat.mtime;
      await this.writeCache(path, text);
    } catch (error) {
      if (isOffline(error)) this.markOffline();
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

  async list(path: string): Promise<DirEntry[]> {
    await this.ready;
    try {
      const entries = await this.inner.list(path);
      this.merge(entries);
      this.markOnline();
      return entries;
    } catch (error) {
      if (isOffline(error)) {
        const cached = this.cachedEntries(path);
        if (cached.length) {
          this.markOffline();
          return cached;
        }
      }
      throw error;
    }
  }

  private merge(entries: DirEntry[]): void {
    let changed = false;
    for (const entry of entries) {
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
        const name = entry.name;
        row.title = name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /** 断网时用 meta.json 里的记录把这一层的目录列出来 */
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

  private async forget(path: string): Promise<void> {
    try {
      await this.store.remove(noteFile(path));
    } catch {
      // 缓存删不掉不影响云端已经删掉的事实
    }
    delete this.meta.notes[path];
    this.scheduleSave();
  }

  async move(from: string, to: string): Promise<void> {
    await this.inner.move(from, to);
    try {
      const text = await this.readCache(from);
      if (text !== null) {
        await this.store.write(noteFile(to), text);
        await this.store.remove(noteFile(from));
      }
    } catch {
      // 副本搬不过去下次读云端补上
    }
    const row = this.meta.notes[from];
    delete this.meta.notes[from];
    if (row) {
      row.folder = parentOf(to);
      this.meta.notes[to] = row;
    }
    this.scheduleSave();
  }

  async mkdir(path: string): Promise<void> {
    await this.inner.mkdir(path);
    if (path && !this.folders.has(path)) {
      this.folders.add(path);
      this.scheduleSave();
    }
  }

  async ensureDir(path: string): Promise<void> {
    await this.inner.ensureDir(path);
    const clean = path.replace(/^\/+|\/+$/g, '');
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
