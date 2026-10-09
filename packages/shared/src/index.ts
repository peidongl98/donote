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
  | 'gone'
  | 'password_required'
  | 'conflict'
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
  /**
   * 验证码明文。仅在两种情况下返回：
   *   dev 环境（未配短信凭证的降级模式）、以及 env.TEST_LOGIN_PHONES 白名单内的号码。
   * 其余情况恒为 undefined。
   */
  devCode?: string;
  /** 走的是测试账号免短信通道（便于前端提示与日志区分） */
  testChannel?: boolean;
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

/* ------------------------------ 笔记 ------------------------------ */

export interface NoteDTO {
  id: string;
  folder_id: string | null;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  version: number;
}

/** 列表项不含正文，只带摘要，避免一次拉回全部内容 */
export interface NoteSummaryDTO {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface NoteListResult {
  items: NoteSummaryDTO[];
  total: number;
  limit: number;
  offset: number;
}

/* ----------------------------- 文件夹 ----------------------------- */

export interface FolderDTO {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
  /** 直系笔记数（不含子文件夹） */
  note_count: number;
}

/* ------------------------------ 分享 ------------------------------ */

export interface ShareDTO {
  id: string;
  note_id: string;
  note_title: string;
  slug: string;
  has_password: boolean;
  expires_at: number | null;
  view_count: number;
  created_at: number;
}

/** 公开分享页内容（无需登录） */
export interface PublicShareDTO {
  slug: string;
  title: string;
  content: string;
  updated_at: number;
}

/** 软删除、撤销、过期统一用这个状态码与错误码 */
export const SHARE_GONE_CODE = 'gone';

export const NOTE_LIMITS = {
  /** 单篇笔记正文上限（字符） */
  maxContent: 200_000,
  maxTitle: 200,
  maxFolderName: 60,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;

/** 认证接口路径（版本化：/api/v1） */
export const API_PREFIX = '/api/v1';

export const AUTH_ROUTES = {
  sendCode: `${API_PREFIX}/auth/send-code`,
  verify: `${API_PREFIX}/auth/verify`,
  me: `${API_PREFIX}/auth/me`,
  logout: `${API_PREFIX}/auth/logout`,
} as const;

/** 资源接口根路径；具体条目由前端拼 :id */
export const RESOURCE_ROUTES = {
  notes: `${API_PREFIX}/notes`,
  folders: `${API_PREFIX}/folders`,
  shares: `${API_PREFIX}/shares`,
  publicShares: `${API_PREFIX}/public/shares`,
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
