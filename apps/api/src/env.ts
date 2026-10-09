import type { TenantDTO, UserDTO } from '@donote/shared';

/** wrangler.toml 的 [vars] / secrets 映射；凭证全部可选，缺失即 dev 降级 */
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
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
