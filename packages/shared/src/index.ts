/**
 * 前后端共享的类型与常量。
 * 该包不走构建：main/types/exports 直接指向 TS 源码（参考 synap.md 的 packages 分发方式）。
 */

/** 业务错误码。前端按 code 分支，不解析 message。 */
export type ApiErrorCode =
  | 'invalid_phone'
  | 'invalid_code'
  | 'code_expired'
  | 'code_locked'
  | 'rate_limited'
  | 'unauthorized'
  | 'sms_not_configured'
  | 'sms_send_failed'
  | 'invalid_payload'
  | 'not_found'
  | 'internal';

export interface ApiErrorBody {
  success: false;
  error: { code: ApiErrorCode; message: string };
}

export interface ApiOk<T> {
  success: true;
  data: T;
}

export interface UserDTO {
  id: string;
  phone: string;
  nickname: string | null;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface TenantDTO {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  created_at: number;
}

export interface SendCodeResult {
  /** 仅 dev 环境返回；production 恒为 undefined */
  devCode?: string;
}

export interface VerifyResult {
  token: string;
  user: UserDTO;
  tenant: TenantDTO;
}

export interface MeResult {
  user: UserDTO;
  tenant: TenantDTO;
}

/** 认证接口路径（版本化：/api/v1） */
export const API_PREFIX = '/api/v1';

export const AUTH_ROUTES = {
  sendCode: `${API_PREFIX}/auth/send-code`,
  verify: `${API_PREFIX}/auth/verify`,
  me: `${API_PREFIX}/auth/me`,
  logout: `${API_PREFIX}/auth/logout`,
} as const;

/** 防刷阈值（前后端共用，前端用于倒计时与提示） */
export const RATE_LIMITS = {
  /** 同手机号发送间隔（秒） */
  sendIntervalSec: 60,
  /** 同手机号 24 小时内最多发送次数 */
  phoneDailyMax: 10,
  /** 同 IP 1 小时内最多发送次数 */
  ipHourlyMax: 20,
  /** 验证码有效期（毫秒） */
  codeTtlMs: 5 * 60 * 1000,
  /** 连续错误次数上限，达到后锁定 */
  maxAttempts: 3,
  /** 锁定市场（毫秒） */
  lockMs: 10 * 60 * 1000,
  /** session 有效期（毫秒） */
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/** 中国大陆手机号 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/;
