import type { FolderDTO, NoteDTO, NoteSummaryDTO, TenantDTO, UserDTO } from '@donote/shared';

/** wrangler.toml 的 [vars] / secrets 映射；凭证全部可选，缺失即 dev 降级 */
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  /**
   * 测试账号白名单（逗号分隔的 11 位手机号）。
   * 命中白名单的号码跳过腾讯云短信，直接用响应回传的验证码登录；
   * 留空 = 完全关闭，不会存在任何免短信入口。
   */
  TEST_LOGIN_PHONES?: string;
  TENCENT_SECRET_ID?: string;
  TENCENT_SECRET_KEY?: string;
  TENCENT_SMS_SDK_APP_ID?: string;
  TENCENT_SMS_SIGN_NAME?: string;
  TENCENT_SMS_TEMPLATE_ID?: string;
}

export interface UserRow {
  id: string;
  phone: string;
  nickname: string | null;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number | null;
}

export interface TenantRow {
  id: string;
  name: string;
  owner_id: string;
  plan: string;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: string;
  tenant_id: string | null;
  expires_at: number;
}

export interface AuthState {
  token: string;
  userId: string;
  tenantId: string;
  user: UserDTO;
  tenant: TenantDTO;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    auth: AuthState;
    /** 频率限制中间件解析出的手机号，供 send-code 处理器复用 */
    sendCodePhone: string;
  };
}

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    phone: row.phone,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

export function toTenantDTO(row: TenantRow): TenantDTO {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    plan: row.plan,
    created_at: row.created_at,
  };
}

/* ------------------------------ 笔记 ------------------------------ */

export interface NoteRow {
  id: string;
  tenant_id: string;
  user_id: string;
  folder_id: string | null;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  version: number;
}

/** 列表查询只取正文前 120 字符，字段名保持与 DTO 对齐 */
export interface NoteSummaryRow {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface FolderRow {
  id: string;
  tenant_id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface ShareRow {
  id: string;
  note_id: string;
  tenant_id: string;
  slug: string;
  password: string | null;
  expires_at: number | null;
  view_count: number;
  created_at: number;
}

export function toNoteDTO(row: NoteRow): NoteDTO {
  return {
    id: row.id,
    folder_id: row.folder_id,
    title: row.title,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    version: row.version,
  };
}

export function toNoteSummaryDTO(row: NoteSummaryRow): NoteSummaryDTO {
  return {
    id: row.id,
    folder_id: row.folder_id,
    title: row.title,
    excerpt: row.excerpt,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export function toFolderDTO(row: FolderRow, noteCount = 0): FolderDTO {
  return {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    note_count: noteCount,
  };
}
