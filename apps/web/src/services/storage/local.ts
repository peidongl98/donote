/**
 * 本地模式：不走任何服务器，笔记就落在这台机器上。
 *
 * 对外它只是一个普通的 `StorageAdapter`（`kind: 'local'`），业务层（笔记 / 文件夹 / 回收站 /
 * 搜索 / 附件 / 导出）一行都不用改 —— 这也是当初做适配器抽象的目的。
 *
 * 两套落盘实现，接口一样：
 * - **端上**（`TauriBackend`）：真文件，交给 Rust 的 `local_*` 命令。落点由 `local.rs` 决定
 *   （绿色版跟着 exe 走、安装版落在「文档/DoNote」），前端只管拿到绝对路径显示出来。
 * - **浏览器**（`IdbBackend`）：IndexedDB。不是为了给人用，是为了让回归套件能跑 ——
 *   dev 与自动化都在浏览器里，没有它本地模式就没法验。
 *
 * 与网盘模式的区别只有两处，都在适配器里吃掉：
 * 1. 没有 ETag。用 `mtime` 当内容指纹（`etagOf`），业务层只拿它比对「变没变」；
 * 2. 没有「缓存层」。本地文件就是原件，`CachedStorage` 不进这条链路 ——
 *    所以 `preferCache` / `fresh` 这些选项在这里一律忽略。
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/storage/transport';
import {
  StorageError,
  type BatchOperation,
  type BatchResult,
  type ConnectResult,
  type DirEntry,
  type FileStat,
  type ListOptions,
  type ReadOptions,
  type StorageAdapter,
  type StorageConfig,
  type WriteContent,
  type WriteResult,
} from './types';

/* ───────────────────────────── 落盘接口 ───────────────────────────── */

export interface LocalStat {
  size: number;
  /** 毫秒时间戳 */
  mtime: number;
  isDir: boolean;
}

export interface LocalEntry {
  name: string;
  size: number;
  mtime: number;
  isDir: boolean;
}

export interface LocalInfo {
  /** 绝对路径；浏览器下是 IndexedDB 的库名 */
  dir: string;
  /** portable / documents / appdata / idb */
  kind: string;
  fallback: boolean;
}

interface LocalBackend {
  info(): Promise<LocalInfo>;
  readBytes(path: string): Promise<ArrayBuffer>;
  writeBytes(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  stat(path: string): Promise<LocalStat | null>;
  list(path: string): Promise<LocalEntry[]>;
  mkdirp(path: string): Promise<void>;
  openDir(): Promise<void>;
}

/* ───────────────────────────── base64 ───────────────────────────── */

/** ArrayBuffer → base64。分块拼，避免大图时 `String.fromCharCode(...big)` 爆栈 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ───────────────────────────── 端上实现 ───────────────────────────── */

class TauriBackend implements LocalBackend {
  async info(): Promise<LocalInfo> {
    return invoke<LocalInfo>('local_info');
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    // Rust 侧用 tauri::ipc::Response 回二进制，到前端就是 ArrayBuffer
    const data = await invoke<ArrayBuffer | number[]>('local_read', { path });
    return data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
  }

  async writeBytes(path: string, data: ArrayBuffer): Promise<void> {
    await invoke('local_write', { path, data: toBase64(data) });
  }

  async remove(path: string): Promise<void> {
    await invoke('local_remove', { path });
  }

  async move(from: string, to: string): Promise<void> {
    await invoke('local_move', { from, to });
  }

  async stat(path: string): Promise<LocalStat | null> {
    const raw = await invoke<{ size: number; mtime: number; is_dir: boolean } | null>('local_stat', {
      path,
    });
    return raw ? { size: raw.size, mtime: raw.mtime, isDir: raw.is_dir } : null;
  }

  async list(path: string): Promise<LocalEntry[]> {
    const rows = await invoke<{ name: string; size: number; mtime: number; is_dir: boolean }[]>(
      'local_list',
      { path },
    );
    return rows.map((row) => ({
      name: row.name,
      size: row.size,
      mtime: row.mtime,
      isDir: row.is_dir,
    }));
  }

  async mkdirp(path: string): Promise<void> {
    await invoke('local_mkdir', { path });
  }

  async openDir(): Promise<void> {
    await invoke('local_open_dir');
  }
}

/* ───────────────────────────── 浏览器实现 ───────────────────────────── */

const DB_NAME = 'donote-local';
const STORE = 'files';

interface IdbRecord {
  path: string;
  isDir: boolean;
  mtime: number;
  data?: ArrayBuffer;
}

/** 目录记录用一个不可能与真实文件名相撞的后缀（真实文件名里不会出现控制字符） */
const DIR_MARK = '\u0000dir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 一次事务做完就关连接：IndexedDB 的连接长期挂着会挡住版本升级（dev 里热更就吃过这个） */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result: T | undefined;
      const request = run(store);
      if (request) request.onsuccess = () => (result = request.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 一层目录下的直接子项路径 → 父路径（'' 表示根） */
function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

class IdbBackend implements LocalBackend {
  async info(): Promise<LocalInfo> {
    return { dir: `浏览器本地库 ${DB_NAME}`, kind: 'idb', fallback: false };
  }

  private async get(path: string): Promise<IdbRecord | undefined> {
    return withStore<IdbRecord | undefined>('readonly', (store) => store.get(path));
  }

  private async put(record: IdbRecord): Promise<void> {
    await withStore('readwrite', (store) => store.put(record));
  }

  private async del(path: string): Promise<void> {
    await withStore('readwrite', (store) => store.delete(path));
  }

  /** 这条路径下所有后代（含自身），删除 / 改名时用来整棵树搬 */
  private async subtree(path: string): Promise<IdbRecord[]> {
    const rows = await withStore<IdbRecord[]>('readonly', (store) =>
      store.getAll(IDBKeyRange.bound(path, `${path}\uffff`)),
    );
    return (rows ?? []).filter((row) => row.path === path || row.path.startsWith(`${path}/`));
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    const record = await this.get(path);
    if (!record || record.isDir || !record.data) {
      throw new StorageError('not_found', '这个文件不在了', 404);
    }
    return record.data;
  }

  async writeBytes(path: string, data: ArrayBuffer): Promise<void> {
    await this.mkdirp(parentOf(path));
    await this.put({ path, isDir: false, mtime: Date.now(), data });
  }

  async remove(path: string): Promise<void> {
    const rows = await this.subtree(path);
    for (const row of rows) await this.del(row.path);
  }

  async move(from: string, to: string): Promise<void> {
    const rows = await this.subtree(from);
    if (!rows.length) throw new StorageError('not_found', '要移动的东西不在了', 404);
    await this.mkdirp(parentOf(to));
    for (const row of rows) {
      const next = row.path === from ? to : `${to}${row.path.slice(from.length)}`;
      await this.put({ ...row, path: next, mtime: Date.now() });
      await this.del(row.path);
    }
  }

  async stat(path: string): Promise<LocalStat | null> {
    const record = await this.get(path);
    if (!record) return null;
    return { size: record.data?.byteLength ?? 0, mtime: record.mtime, isDir: record.isDir };
  }

  async list(path: string): Promise<LocalEntry[]> {
    const rows = await withStore<IdbRecord[]>('readonly', (store) =>
      store.getAll(IDBKeyRange.bound(path ? `${path}/` : '', `${path ? `${path}/` : ''}\uffff`)),
    );
    const prefix = path ? `${path}/` : '';
    return (rows ?? [])
      .filter((row) => row.path.startsWith(prefix) && !row.path.slice(prefix.length).includes('/'))
      .map((row) => ({
        name: row.path.slice(prefix.length),
        size: row.data?.byteLength ?? 0,
        mtime: row.mtime,
        isDir: row.isDir,
      }));
  }

  async mkdirp(path: string): Promise<void> {
    if (!path) return;
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const record = await this.get(current);
      if (!record) await this.put({ path: current, isDir: true, mtime: Date.now() });
    }
  }

  async openDir(): Promise<void> {
    /* 浏览器里没有可打开的目录 */
  }
}

/* ───────────────────────────── 适配器 ───────────────────────────── */

function toBytes(content: WriteContent): Promise<ArrayBuffer> {
  if (typeof content === 'string') return Promise.resolve(new TextEncoder().encode(content).buffer);
  if (content instanceof Blob) return content.arrayBuffer();
  return Promise.resolve(content);
}

function mapError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not_found|不在了|读不到/.test(message)) {
    throw new StorageError('not_found', '这个文件不在了', 404);
  }
  throw new StorageError('other', message);
}

export class LocalAdapter implements StorageAdapter {
  readonly kind = 'local' as const;

  private backend: LocalBackend = isTauriRuntime() ? new TauriBackend() : new IdbBackend();
  private info: LocalInfo | null = null;

  /** 落点信息（绝对路径等），界面显示用 */
  location(): LocalInfo | null {
    return this.info;
  }

  async connect(_config: StorageConfig): Promise<ConnectResult> {
    this.info = await this.backend.info();
    await this.backend.mkdirp('');
    return { createdRoot: false };
  }

  adopt(_config: StorageConfig): void {
    /* 本地模式没有凭据要装配，落点在 connect 里取 */
  }

  async disconnect(): Promise<void> {
    /* 本地模式没有连接可断 */
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.backend.list('');
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string, _options?: ReadOptions): Promise<string> {
    try {
      const bytes = await this.backend.readBytes(path);
      return new TextDecoder().decode(bytes);
    } catch (error) {
      mapError(error);
    }
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    try {
      return await this.backend.readBytes(path);
    } catch (error) {
      mapError(error);
    }
  }

  async write(path: string, content: WriteContent, _etag?: string): Promise<WriteResult> {
    try {
      const data = await toBytes(content);
      await this.backend.writeBytes(path, data);
      return { etag: String(Date.now()), mtime: Date.now() };
    } catch (error) {
      mapError(error);
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await this.backend.remove(path);
    } catch (error) {
      mapError(error);
    }
  }

  async move(from: string, to: string): Promise<void> {
    try {
      await this.backend.move(from, to);
    } catch (error) {
      mapError(error);
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      const stat = path ? await this.backend.stat(path) : { size: 0, mtime: Date.now(), isDir: true };
      if (!stat) throw new StorageError('not_found', '这个文件不在了', 404);
      return { path, size: stat.size, mtime: stat.mtime, isDirectory: stat.isDir, etag: String(stat.mtime) };
    } catch (error) {
      mapError(error);
    }
  }

  async list(path: string, _options?: ListOptions): Promise<DirEntry[]> {
    try {
      const rows = await this.backend.list(path);
      return rows.map((row) => ({
        name: row.name,
        path: path ? `${path}/${row.name}` : row.name,
        isDirectory: row.isDir,
        size: row.size,
        mtime: row.mtime,
        etag: String(row.mtime),
      }));
    } catch (error) {
      mapError(error);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.backend.mkdirp(path);
    } catch (error) {
      mapError(error);
    }
  }

  async ensureDir(path: string): Promise<void> {
    await this.mkdir(path);
  }

  async batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    const out: BatchResult[] = [];
    for (const op of operations) {
      try {
        if (op.type === 'write') await this.write(op.path, op.content, op.etag);
        else if (op.type === 'delete') await this.delete(op.path);
        else if (op.type === 'move') await this.move(op.from, op.to);
        else await this.mkdir(op.path);
        out.push({ op, ok: true });
      } catch (error) {
        out.push({
          op,
          ok: false,
          error: error instanceof StorageError ? error : new StorageError('other', String(error)),
        });
      }
    }
    return out;
  }
}

/** 让设置页能把「在文件管理器里打开」这条路口接到当前后端，不必知道它是哪种实现 */
export async function openLocalDir(): Promise<void> {
  const backend: LocalBackend = isTauriRuntime() ? new TauriBackend() : new IdbBackend();
  await backend.openDir();
}
