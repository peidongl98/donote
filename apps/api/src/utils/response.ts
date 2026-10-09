import type { ApiErrorCode } from '@donote/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';

/** 业务异常：抛出后由 app.onError 统一转成 { success:false, error } */
export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: ApiErrorCode, message: string, status: ContentfulStatusCode) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.status = status;
  }
}

/**
 * 成功响应形态按任务书：{ success: true, ...data }（扁平，不套 data 层）。
 */
export function ok<T extends Record<string, unknown>>(
  c: Context<AppEnv>,
  data: T,
  status: ContentfulStatusCode = 200,
): Response {
  return c.json({ success: true, ...data }, status);
}

export function fail(
  c: Context<AppEnv>,
  code: ApiErrorCode,
  message: string,
  status: ContentfulStatusCode,
): Response {
  return c.json({ success: false, error: { code, message } }, status);
}
