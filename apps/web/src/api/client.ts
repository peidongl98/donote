import type { ApiErrorCode, ApiErrorBody } from '@donote/shared';

/** dev 留空 → 走 Vite 同源代理；production 注入 Worker 域名 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 明确要求不带 Authorization（登录前接口） */
  anonymous?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous && authToken) headers['Authorization'] = `Bearer ${authToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError('internal', '网络连接失败，请稍后重试', 0);
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError('internal', '服务返回异常', res.status);
  }

  if (!res.ok) {
    const body = payload as ApiErrorBody;
    const code = body?.error?.code ?? 'internal';
    const message = body?.error?.message ?? '请求失败';
    throw new ApiError(code, message, res.status);
  }

  return payload as T;
}
