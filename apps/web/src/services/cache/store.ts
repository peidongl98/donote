/**
 * 缓存文件的落盘层。
 *
 * 端上走 Rust 的 `cache_*` 命令，落在安装目录的 `data/cache/`；
 * 浏览器里没有「安装目录」这回事，退化成 localStorage —— 只为让 dev 与静态站点
 * 跑得起来，不报错、也不假装有离线能力（`location()` 返回 null，状态点保持在线）。
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/storage/transport';

export interface CacheLocation {
  /** 缓存根目录的绝对路径 */
  dir: string;
  /** true = 安装目录不可写，回落到了应用数据目录 */
  fallback: boolean;
}

export interface CacheStore {
  /** 缓存根位置；浏览器下为 null */
  location(): Promise<CacheLocation | null>;
  read(rel: string): Promise<string | null>;
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** 列某个目录下的文件，返回相对缓存根的路径 */
  list(rel: string): Promise<string[]>;
  openDir(): Promise<void>;
  /** 在文件管理器里定位 `notes/` 下的一条路径（笔记或文件夹）；浏览器下没有可打开的目录，静默跳过 */
  reveal(rel: string): Promise<void>;
}

const LS_PREFIX = 'donote.cache:';

/** 浏览器兜底。只为让 dev / 静态站跑通，不承诺容量与持久性。 */
function createWebStore(): CacheStore {
  const key = (rel: string) => `${LS_PREFIX}${rel}`;
  return {
    async location() {
      return null;
    },
    async read(rel) {
      try {
        return localStorage.getItem(key(rel));
      } catch {
        return null;
      }
    },
    async write(rel, content) {
      try {
        localStorage.setItem(key(rel), content);
      } catch {
        // 配额满了就放弃缓存，不影响主流程
      }
    },
    async remove(rel) {
      try {
        localStorage.removeItem(key(rel));
      } catch {
        // 同上
      }
    },
    async list(prefix) {
      const head = `${LS_PREFIX}${prefix.replace(/\/+$/, '')}`;
      const out: string[] = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.key(i);
          if (raw && raw.startsWith(head)) out.push(raw.slice(LS_PREFIX.length));
        }
      } catch {
        // 读不到就当空
      }
      return out;
    },
    async openDir() {
      // 浏览器下没有可以打开的目录，静默跳过
    },
    async reveal() {
      // 同上：本地缓存只存在于端上
    },
  };
}

function createTauriStore(): CacheStore {
  return {
    location: () => invoke<CacheLocation>('cache_dir'),
    read: (rel) => invoke<string | null>('cache_read', { path: rel }),
    write: (rel, content) => invoke<void>('cache_write', { path: rel, content }),
    remove: (rel) => invoke<void>('cache_remove', { path: rel }),
    list: (rel) => invoke<string[]>('cache_list', { path: rel }),
    openDir: () => invoke<void>('cache_open_dir'),
    reveal: (rel) => invoke<void>('cache_reveal', { rel }),
  };
}

let current: CacheStore | null = null;

export function cacheStore(): CacheStore {
  if (!current) current = isTauriRuntime() ? createTauriStore() : createWebStore();
  return current;
}
