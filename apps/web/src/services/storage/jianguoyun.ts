/**
 * 坚果云 WebDAV 适配器。
 *
 * 请求全部经 @/storage/transport 的 davFetch 发出，与改造前完全一致：
 *   端上（Tauri）→ tauri-plugin-http（Rust reqwest），不受 CORS 限制
 *   dev（浏览器）→ Vite 同源代理 /nutdav，绕开坚果云不返回 CORS 响应头的问题
 *
 * 本文件是「直接调坚果云」的唯一落点。改造前后发出的请求逐条对应，
 * method / header / body 都没有变，也没有引入新的请求模式。
 */

import { davFetch, isTauriRuntime } from '@/storage/transport';
import {
  DEFAULT_ROOT,
  StorageError,
  type BatchOperation,
  type BatchResult,
  type ConnectResult,
  type DirEntry,
  type FileStat,
  type StorageAdapter,
  type StorageConfig,
  type WriteResult,
} from './types';

const DEFAULT_BASE = 'https://dav.jianguoyun.com/dav';
const PROP_BODY =
  '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getlastmodified/></prop></propfind>';

/**
 * dev（纯浏览器）没有可用的原生网络栈，坚果云又不返回 CORS 响应头，
 * 只能走 Vite 的同源代理 /nutdav（见 apps/web/vite.config.ts）。
 * 端上走原生 reqwest，直接用绝对地址。
 */
function resolveRequestBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (import.meta.env.DEV && !isTauriRuntime()) {
    return `/nutdav${new URL(base).pathname.replace(/\/+$/, '')}`;
  }
  return base;
}

interface DavEntry {
  rel: string;
  name: string;
  isDir: boolean;
  mtime: number;
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

/** href → 相对同步根的路径；不属于同步根则返回 null */
function hrefToRel(href: string, davPrefix: string, root: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(href);
  } catch {
    path = href;
  }
  const at = path.indexOf(davPrefix);
  if (at >= 0) path = path.slice(at + davPrefix.length);
  if (path.replace(/\/+$/, '') === root) return '';
  if (!path.startsWith(`${root}/`)) return null;
  return path.slice(root.length + 1).replace(/\/+$/, '');
}

/** skipSelf 为 false 时保留被查询目录自身（stat 要用） */
function parseMultistatus(
  xml: string,
  davPrefix: string,
  root: string,
  baseRel: string,
  skipSelf: boolean,
): DavEntry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out: DavEntry[] = [];
  for (const node of Array.from(doc.getElementsByTagNameNS('DAV:', 'response'))) {
    const href = node.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent?.trim();
    if (!href) continue;
    const prop = pickProp(node);
    if (!prop) continue;
    const rel = hrefToRel(href, davPrefix, root);
    if (rel === null) continue;
    if (skipSelf && rel === baseRel) continue;
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

export class JianguoYunAdapter implements StorageAdapter {
  readonly kind = 'jianguoyun' as const;

  private config: StorageConfig | null = null;
  /** 实际发请求的前缀：dev 下是同源代理，端上是绝对地址 */
  private requestBase = '';

  /* ------------------------------ 地址与认证 ------------------------------ */

  private root(): string {
    return (this.config?.root || DEFAULT_ROOT).replace(/\/+$/, '');
  }

  /** 相对同步根 → 以同步根开头的路径，每段做 URL 编码。rel 为空时就是同步根本身 */
  private abs(rel: string): string {
    const clean = rel.replace(/^\/+|\/+$/g, '');
    const base = this.root();
    if (!clean) return base;
    return `${base}/${clean.split('/').map(encodeURIComponent).join('/')}`;
  }

  private url(rel: string): string {
    return `${this.requestBase}${this.abs(rel)}`;
  }

  /** Destination 必须是绝对地址，因此不能复用 dev 下的同源代理前缀 */
  private originUrl(rel: string): string {
    const base = (this.config?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    return `${base}${this.abs(rel)}`;
  }

  private auth(): string {
    const c = this.config;
    if (!c) throw new StorageError('not_connected', '还没连接存储，请先完成连接');
    // 账号是邮箱、应用密码是 16 位字母数字，都是纯 ASCII，btoa 安全
    return `Basic ${btoa(`${c.account}:${c.password}`)}`;
  }

  /** 统一把「请求根本没发出去」翻译成一个可读错误，不让底层异常直接漏到界面 */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await davFetch(url, init);
    } catch {
      throw new StorageError('unreachable', '连不上坚果云，请检查网络', 0);
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /**
   * 只装配配置、不发任何请求。给「启动时恢复连接态」用。
   */
  adopt(config: StorageConfig): void {
    this.config = config;
    this.requestBase = resolveRequestBase(config.baseUrl);
  }

  async connect(config: StorageConfig): Promise<ConnectResult> {
    this.adopt(config);

    const probe = await this.probe(config.root);
    if (probe.kind === 'unauthorized') {
      throw new StorageError('unauthorized', '账号或应用密码不对，请核对后重试', 401);
    }
    if (probe.kind === 'forbidden') {
      throw new StorageError(
        'forbidden',
        '被坚果云拒绝。多半是开了微信二次验证 —— WebDAV 不支持它，请先在网页端关掉',
        403,
      );
    }
    if (probe.kind === 'unreachable') {
      const reason = probe.reason ? `（${probe.reason.slice(0, 120)}）` : '';
      throw new StorageError(
        'unreachable',
        `连不上坚果云，请检查网络（网页版会被浏览器的跨域策略拦住，属预期）${reason}`,
        0,
      );
    }
    if (probe.kind === 'error') {
      throw new StorageError('other', `连接失败，请稍后重试（HTTP ${probe.status}）`, probe.status);
    }

    if (!probe.rootExists) {
      await this.mkcolAbs(config.root);
      return { createdRoot: true };
    }
    return { createdRoot: false };
  }

  async disconnect(): Promise<void> {
    this.config = null;
    this.requestBase = '';
  }

  async testConnection(): Promise<boolean> {
    if (!this.config) return false;
    try {
      const probe = await this.probe(this.config.root);
      return probe.kind === 'ok';
    } catch {
      return false;
    }
  }

  /** href 里剥掉的前缀取自真实服务端地址，dev 的同源代理前缀不参与 */
  private davPrefix(): string {
    return davPrefixOf(this.config?.baseUrl ?? DEFAULT_BASE);
  }

  /**
   * 探测凭据 + 同步根。
   * 先探同步根：404 只说明目录不存在（认证已经过了），再拿根路径确认一次认证状态。
   */
  private async probe(
    root: string,
  ): Promise<
    | { kind: 'ok'; rootExists: boolean }
    | { kind: 'unauthorized' }
    | { kind: 'forbidden' }
    | { kind: 'unreachable'; reason?: string }
    | { kind: 'error'; status: number }
  > {
    const target = root.replace(/\/+$/, '') || DEFAULT_ROOT;
    let status: number;
    try {
      status = await this.propfindStatus(target);
    } catch (error) {
      return { kind: 'unreachable', reason: describeThrow(error) };
    }

    if (status === 401) return { kind: 'unauthorized' };
    if (status === 403) return { kind: 'forbidden' };
    if (status === 207) return { kind: 'ok', rootExists: true };

    if (status === 404) {
      // 目录不存在。WebDAV 服务器通常先认证再解析路径，但仍确认一次，
      // 避免把「认证失败」误判成「目录缺失」
      let rootStatus: number;
      try {
        rootStatus = await this.propfindStatus('/');
      } catch (error) {
        return { kind: 'unreachable', reason: describeThrow(error) };
      }
      if (rootStatus === 401) return { kind: 'unauthorized' };
      if (rootStatus === 403) return { kind: 'forbidden' };
      if (rootStatus === 207) return { kind: 'ok', rootExists: false };
      return { kind: 'error', status: rootStatus };
    }

    return { kind: 'error', status };
  }

  /** PROPFIND Depth:0，只取状态码。绝对路径（同步根自身用） */
  private async propfindStatus(absPath: string): Promise<number> {
    const res = await davFetch(`${this.requestBase}${absPath}`, {
      method: 'PROPFIND',
      headers: { Authorization: this.auth(), Depth: '0' },
    });
    return res.status;
  }

  /* ------------------------------ 单文件 / 单目录 ------------------------------ */

  async list(path: string): Promise<DirEntry[]> {
    const res = await this.send(this.url(path), {
      method: 'PROPFIND',
      headers: {
        Authorization: this.auth(),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROP_BODY,
    });
    if (res.status === 404) return [];
    if (res.status === 401) {
      throw new StorageError('unauthorized', '账号或应用密码已失效，请重新连接', 401);
    }
    if (res.status !== 207) {
      throw new StorageError('other', `读取目录失败（HTTP ${res.status}）`, res.status);
    }
    const rel = path.replace(/^\/+|\/+$/g, '');
    return parseMultistatus(await res.text(), this.davPrefix(), this.root(), rel, true).map(
      (entry) => ({
        name: entry.name,
        path: entry.rel,
        isDirectory: entry.isDir,
        mtime: entry.mtime,
      }),
    );
  }

  async read(path: string): Promise<string> {
    const res = await this.send(this.url(path), { headers: { Authorization: this.auth() } });
    if (res.status === 404) throw new StorageError('not_found', '文件不存在', 404);
    if (!res.ok) {
      throw new StorageError('other', `读取笔记失败（HTTP ${res.status}）`, res.status);
    }
    return res.text();
  }

  async write(path: string, content: string, etag?: string): Promise<WriteResult> {
    // etag 通道已预留但本批次不启用：传了也不发 If-Match，保持请求与改造前一致
    void etag;
    const res = await this.send(this.url(path), {
      method: 'PUT',
      headers: { Authorization: this.auth(), 'Content-Type': 'text/markdown; charset=utf-8' },
      body: content,
    });
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw new StorageError('other', `保存失败（HTTP ${res.status}）`, res.status);
    }
    return { etag: '', mtime: Date.now() };
  }

  async delete(path: string): Promise<void> {
    const res = await this.send(this.url(path), {
      method: 'DELETE',
      headers: { Authorization: this.auth() },
    });
    if (res.status === 204 || res.status === 200 || res.status === 404) return;
    throw new StorageError('other', `删除失败（HTTP ${res.status}）`, res.status);
  }

  async move(from: string, to: string): Promise<void> {
    const res = await this.send(this.url(from), {
      method: 'MOVE',
      headers: {
        Authorization: this.auth(),
        Destination: this.originUrl(to),
        Overwrite: 'F',
      },
    });
    if (res.status === 201 || res.status === 204) return;
    if (res.status === 412) throw new StorageError('conflict', '目标位置已有同名条目', 412);
    throw new StorageError('other', `移动失败（HTTP ${res.status}）`, res.status);
  }

  async mkdir(path: string): Promise<void> {
    const res = await this.send(this.url(path), {
      method: 'MKCOL',
      headers: { Authorization: this.auth() },
    });
    if (res.status === 201 || res.status === 405) return;
    throw new StorageError('other', `创建文件夹失败（HTTP ${res.status}）`, res.status);
  }

  /** 建同步根本身（绝对路径），只给 connect 用 */
  private async mkcolAbs(absPath: string): Promise<void> {
    let res: Response;
    try {
      res = await davFetch(`${this.requestBase}${absPath}`, {
        method: 'MKCOL',
        headers: { Authorization: this.auth() },
      });
    } catch {
      return;
    }
    if (res.status === 201 || res.status === 405) return;
    throw new StorageError('other', `创建同步根失败（HTTP ${res.status}）`, res.status);
  }

  async ensureDir(path: string): Promise<void> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (!clean) return;
    let acc = '';
    for (const seg of clean.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      await this.mkdir(acc);
    }
  }

  async stat(path: string): Promise<FileStat> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const res = await this.send(this.url(path), {
      method: 'PROPFIND',
      headers: {
        Authorization: this.auth(),
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROP_BODY,
    });
    if (res.status === 404) throw new StorageError('not_found', '条目不存在', 404);
    if (res.status !== 207) {
      throw new StorageError('other', `读取状态失败（HTTP ${res.status}）`, res.status);
    }
    const entries = parseMultistatus(
      await res.text(),
      this.davPrefix(),
      this.root(),
      clean,
      false,
    );
    const self = entries.find((entry) => entry.rel === clean);
    if (!self) throw new StorageError('not_found', '条目不存在', 404);
    return {
      path: clean,
      size: 0,
      mtime: self.mtime,
      isDirectory: self.isDir,
      etag: '',
    };
  }

  /* ------------------------------ 批量 ------------------------------ */

  /**
   * WebDAV 没有原生批量写接口（不像 S3 的 POST /?delete），所以这里能做的是：
   *   1. 串行执行 —— 天然把并发压到 1，不会触发坚果云的并发限流；
   *   2. 同一批次里重复的 mkdir 只发一次；
   *   3. 单条失败不中断整批，按序返回每条结果，让调用方自己决定怎么处理。
   *
   * 换句话说：batch 解决的是「限流与顺序」，不是「请求合并」。
   * 真正的请求合并要靠上层少调几次接口（例如复用一次目录遍历的结果）。
   */
  async batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    const out: BatchResult[] = [];
    const madeDirs = new Set<string>();

    for (const op of operations) {
      try {
        switch (op.type) {
          case 'mkdir': {
            const key = op.path.replace(/^\/+|\/+$/g, '');
            if (!madeDirs.has(key)) {
              await this.mkdir(key);
              madeDirs.add(key);
            }
            out.push({ op, ok: true });
            break;
          }
          case 'write': {
            const written = await this.write(op.path, op.content, op.etag);
            if (op.path.includes('/')) madeDirs.add(op.path.slice(0, op.path.lastIndexOf('/')));
            out.push({ op, ok: true, etag: written.etag, mtime: written.mtime });
            break;
          }
          case 'delete':
            await this.delete(op.path);
            out.push({ op, ok: true });
            break;
          case 'move':
            await this.move(op.from, op.to);
            out.push({ op, ok: true });
            break;
        }
      } catch (error) {
        out.push({
          op,
          ok: false,
          error:
            error instanceof StorageError
              ? error
              : new StorageError('other', error instanceof Error ? error.message : String(error)),
        });
      }
    }

    return out;
  }
}

/** 从实际请求前缀里取出要剥掉的路径部分，用于把 href 还原成相对路径 */
function davPrefixOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return '/dav';
  }
}

/**
 * 把「请求根本没发出去」的原因扒出来。
 * 端上最常见的是被 http 插件的域名白名单拦下（capabilities/default.json），
 * 这种情况下错误信息本身才是唯一线索，不能吞掉。
 */
function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
