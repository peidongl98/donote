/**
 * 存储后端抽象层。
 *
 * 上层业务（笔记 / 文件夹 / 搜索 / 回收站）只依赖这里定义的接口，
 * 不关心底层是坚果云，还是 Nextcloud / 群晖 / 用户自建的 WebDAV 服务器。
 *
 * 路径约定：所有 path 都是「相对同步根」的路径，例如
 *   ''            同步根本身
 *   '工作/周报.md'  同步根下的笔记
 * 不以 `/` 开头，也不含同步根前缀。适配器内部负责拼成绝对地址。
 * 这个约定沿用改造前的 rel 语义，业务层因此几乎不用改。
 */

/**
 * 存储后端种类。目前只有一种：标准 WebDAV 协议。
 * 坚果云、Nextcloud、群晖、自建服务都走它，差别只在地址与凭据。
 */
export type StorageKind = 'webdav';

/** 默认服务器：坚果云。用户可以改成任意 WebDAV 地址 */
export const DEFAULT_BASE_URL = 'https://dav.jianguoyun.com/dav';

/** 同步根：DoNote 只在这个目录里活动，不碰用户网盘里的其它东西 */
export const DEFAULT_ROOT = '/DoNote';

export interface StorageConfig {
  kind: StorageKind;
  /** WebDAV 基地址（不含同步根），例如 https://dav.jianguoyun.com/dav */
  baseUrl: string;
  /** 账号。坚果云是注册邮箱，自建服务多为用户名 */
  account: string;
  /** 密码。坚果云必须用「应用密码」，不是登录密码 */
  password: string;
  /** 同步根。DoNote 只在这个目录里活动，不碰用户网盘里的其它东西 */
  root: string;
}

export interface ConnectResult {
  /** 同步根此前不存在，是这次连接顺手建出来的 */
  createdRoot: boolean;
}

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
  /**
   * 乐观锁用。本批次恒为空串 —— 通道已预留，尚未启用。
   * 启用需要改 PROPFIND 的 property 列表（加 getetag），属于网络行为变更，
   * 留到真正要做冲突处理时再开。
   */
  etag: string;
}

export interface DirEntry {
  name: string;
  /** 相对同步根的路径 */
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

export interface WriteResult {
  /** 同 FileStat.etag，本批次为空串 */
  etag: string;
  mtime: number;
}

export type BatchOperation =
  | { type: 'write'; path: string; content: string; etag?: string }
  | { type: 'delete'; path: string }
  | { type: 'move'; from: string; to: string }
  | { type: 'mkdir'; path: string };

export interface BatchResult {
  op: BatchOperation;
  ok: boolean;
  /** ok 为 false 时带上原因。单条失败不会中断整个批次 */
  error?: StorageError;
  etag?: string;
  mtime?: number;
}

export type StorageErrorCode =
  /** 还没连接就来调业务接口 */
  | 'not_connected'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  /** 目标已存在（MOVE 的 412） */
  | 'conflict'
  /** 请求根本没发出去，或发出去了没人应答 */
  | 'unreachable'
  | 'other';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** HTTP 状态码；网络层失败时为 0 */
  readonly status: number;

  constructor(code: StorageErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}

export interface StorageAdapter {
  readonly kind: StorageKind;

  /**
   * 连接并校验。凭据由上层注入，适配器不负责持久化。
   * 返回 createdRoot 以便上层提示「顺手建好了同步目录」。
   */
  connect(config: StorageConfig): Promise<ConnectResult>;
  /**
   * 只装配配置、不发任何请求。
   * 给「启动时从系统凭据恢复连接态」用 —— 凭据在连接那一刻已经校验过，
   * 每次启动再打一次探测是白耗限流配额。
   */
  adopt(config: StorageConfig): void;
  disconnect(): Promise<void>;
  testConnection(): Promise<boolean>;

  /* 单文件 / 单目录 */
  read(path: string): Promise<string>;
  write(path: string, content: string, etag?: string): Promise<WriteResult>;
  delete(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  list(path: string): Promise<DirEntry[]>;
  /** 创建单层目录。已存在视为成功 */
  mkdir(path: string): Promise<void>;
  /** 逐级创建目录，等价于对每一级连续调用 mkdir。业务层建深层路径时用 */
  ensureDir(path: string): Promise<void>;

  /**
   * 批量执行。WebDAV 没有原生批量接口，实现是串行执行 + 去重，
   * 目的是把并发压下来避免触发限流，并在可能的范围内少发请求。
   */
  batch(operations: BatchOperation[]): Promise<BatchResult[]>;
}
