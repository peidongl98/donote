import { createMiddleware } from 'hono/factory';
import type { AppEnv, TenantRow, UserRow } from '../env';
import { toTenantDTO, toUserDTO } from '../env';
import { ApiException } from '../utils/response';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

interface SessionJoinRow {
  token: string;
  user_id: string;
  tenant_id: string | null;
  expires_at: number;
  u_id: string;
  phone: string;
  nickname: string | null;
  avatar_url: string | null;
  u_created_at: number;
  last_login_at: number | null;
  t_id: string | null;
  t_name: string | null;
  owner_id: string | null;
  plan: string | null;
  t_created_at: number | null;
}

/**
 * 受保护路由统一入口：校验 Bearer token + 过期时间，并一次性把 user / tenant 取回。
 * 失败一律 401，前端据此清 token 回登录页。
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = BEARER_PATTERN.exec(c.req.header('Authorization')?.trim() ?? '')?.[1];
  if (!token) {
    throw new ApiException('unauthorized', '未登录', 401);
  }

  const row = await c.env.DB.prepare(
    `SELECT s.token, s.user_id, s.tenant_id, s.expires_at,
            u.id AS u_id, u.phone, u.nickname, u.avatar_url,
            u.created_at AS u_created_at, u.last_login_at,
            t.id AS t_id, t.name AS t_name, t.owner_id, t.plan,
            t.created_at AS t_created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(token, Date.now())
    .first<SessionJoinRow>();

  if (!row || !row.t_id || !row.t_name || !row.owner_id || row.t_created_at === null) {
    throw new ApiException('unauthorized', '登录已过期，请重新登录', 401);
  }

  const user: UserRow = {
    id: row.u_id,
    phone: row.phone,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    created_at: row.u_created_at,
    last_login_at: row.last_login_at,
  };
  const tenant: TenantRow = {
    id: row.t_id,
    name: row.t_name,
    owner_id: row.owner_id,
    plan: row.plan ?? 'free',
    created_at: row.t_created_at,
  };

  c.set('auth', {
    token: row.token,
    userId: user.id,
    tenantId: tenant.id,
    user: toUserDTO(user),
    tenant: toTenantDTO(tenant),
  });

  await next();
});
