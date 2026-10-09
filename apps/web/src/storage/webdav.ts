import { davFetch, isTauriRuntime } from './transport';

const DAV_ORIGIN = 'https://dav.jianguoyun.com';

export const DAV_ORIGIN_BASE = `${DAV_ORIGIN}/dav`;

/**
 * 端上（Tauri / 鸿蒙）走原生网络栈，必须用绝对地址；
 * 纯浏览器 dev 走 Vite 同源代理（坚果云不返回 CORS 响应头，直连必被拦）。
 * ⚠️ 纯浏览器生产构建没有可用的传输层——网页版不是产品形态，属已知情况。
 */
export const DAV_BASE = !import.meta.env.DEV || isTauriRuntime() ? DAV_ORIGIN_BASE : '/nutdav/dav';

/** 同步根：DoNote 只在这个目录里活动，不碰用户坚果云里的其它东西 */
export const DEFAULT_ROOT = '/DoNote';

export interface NutstoreCredentials {
  /** 坚果云注册邮箱 */
  account: string;
  /** 应用密码（不是登录密码），在坚果云网页端「第三方应用管理」生成 */
  appPassword: string;
}

export type ProbeResult =
  /** 凭据可用。rootExists 表示同步根目录是否已存在 */
  | { kind: 'ok'; rootExists: boolean }
  /** 账号或应用密码不对 */
  | { kind: 'unauthorized' }
  /** 多半是开了微信二次验证 —— WebDAV 不支持它，需先在网页端关掉 */
  | { kind: 'forbidden' }
  /** 请求根本没发出去，或发出去了没人应答。reason 带上底层原因便于定位 */
  | { kind: 'unreachable'; reason?: string }
  | { kind: 'error'; status: number };

export function davPath(path: string): string {
  return `${DAV_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 账号是邮箱、应用密码是 16 位字母数字，都是纯 ASCII，btoa 安全 */
function authHeader(c: NutstoreCredentials): string {
  return `Basic ${btoa(`${c.account}:${c.appPassword}`)}`;
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

async function propfind(c: NutstoreCredentials, path: string): Promise<number> {
  const res = await davFetch(davPath(path), {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(c), Depth: '0' },
  });
  return res.status;
}

/**
 * 探测凭据 + 同步根。
 * 先探同步根：404 只说明目录不存在（认证已经过了），再拿根路径确认一次认证状态。
 */
export async function probeConnection(
  c: NutstoreCredentials,
  root: string = DEFAULT_ROOT,
): Promise<ProbeResult> {
  let status: number;
  try {
    status = await propfind(c, root);
  } catch (error) {
    return { kind: 'unreachable', reason: describeThrow(error) };
  }

  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 207) return { kind: 'ok', rootExists: true };

  if (status === 404) {
    // 目录不存在。WebDAV 服务器通常先认证再解析路径，但仍确认一次，避免把「认证失败」误判成「目录缺失」
    let rootStatus: number;
    try {
      rootStatus = await propfind(c, '/');
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

/** 创建同步根；已存在（405）也算成功 */
export async function ensureRoot(
  c: NutstoreCredentials,
  root: string = DEFAULT_ROOT,
): Promise<boolean> {
  let res: Response;
  try {
    res = await davFetch(davPath(root), {
      method: 'MKCOL',
      headers: { Authorization: authHeader(c) },
    });
  } catch {
    return false;
  }
  return res.status === 201 || res.status === 405;
}
