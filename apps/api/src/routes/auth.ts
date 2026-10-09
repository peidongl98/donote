import { Hono } from 'hono';
import { PHONE_PATTERN, RATE_LIMITS } from '@donote/shared';
import type { AppEnv, TenantRow, UserRow } from '../env';
import { toTenantDTO, toUserDTO } from '../env';
import { smsRateLimit } from '../middleware/rate-limit';
import { requireSession } from '../middleware/session';
import { newId, randomCode, randomHex } from '../utils/id';
import { ApiException, ok } from '../utils/response';
import { sendSmsCode } from '../utils/tencent-sms';
import { isTestLoginPhone } from '../utils/test-login';

interface PhoneCodeRow {
  phone: string;
  code: string;
  attempts: number;
  locked_until: number | null;
  expires_at: number;
}

const CODE_PATTERN = /^\d{6}$/;

export const authRoutes = new Hono<AppEnv>();

/**
 * POST /api/v1/auth/send-code
 * 前置中间件已完成手机号格式校验与三条防刷阈值。
 */
authRoutes.post('/send-code', smsRateLimit, async (c) => {
  const phone = c.get('sendCodePhone');
  const now = Date.now();
  const code = randomCode();

  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO phone_codes (phone, code, attempts, locked_until, expires_at, created_at)
     VALUES (?, ?, 0, NULL, ?, ?)`,
  )
    .bind(phone, code, now + RATE_LIMITS.codeTtlMs, now)
    .run();

  const ip = c.req.header('CF-Connecting-IP') ?? null;

  // 测试账号：跳过短信通道。验证码依旧随机、入库、5 分钟过期、一码一用。
  if (isTestLoginPhone(c.env, phone)) {
    await c.env.DB.prepare(
      `INSERT INTO sms_logs (id, phone, ip, success, error_code, created_at)
       VALUES (?, ?, ?, 1, 'test_channel', ?)`,
    )
      .bind(newId('sms'), phone, ip, now)
      .run();
    return ok(c, { devCode: code, testChannel: true });
  }

  const outcome = await sendSmsCode(c.env, phone, code);

  await c.env.DB.prepare(
    `INSERT INTO sms_logs (id, phone, ip, success, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('sms'), phone, ip, outcome.delivered ? 1 : 0, outcome.errorCode ?? null, now)
    .run();

  if (!outcome.configured && !outcome.devMode) {
    throw new ApiException('sms_not_configured', '短信服务未配置', 500);
  }
  if (outcome.errorCode) {
    throw new ApiException('sms_send_failed', '验证码发送失败，请稍后重试', 502);
  }

  return ok(c, outcome.devMode ? { devCode: code } : {});
});

/**
 * POST /api/v1/auth/verify
 * 校验通过即消费验证码（一码一用，防重放）。
 */
authRoutes.post('/verify', async (c) => {
  const body = await c.req
    .json<{ phone?: unknown; code?: unknown }>()
    .catch(() => null);
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
  const code = typeof body?.code === 'string' ? body.code.trim() : '';

  if (!PHONE_PATTERN.test(phone)) {
    throw new ApiException('invalid_phone', '请输入正确的 11 位手机号', 400);
  }
  if (!CODE_PATTERN.test(code)) {
    throw new ApiException('invalid_code', '请输入 6 位数字验证码', 400);
  }

  const now = Date.now();
  const record = await c.env.DB.prepare(
    'SELECT phone, code, attempts, locked_until, expires_at FROM phone_codes WHERE phone = ?',
  )
    .bind(phone)
    .first<PhoneCodeRow>();

  if (!record) {
    throw new ApiException('code_expired', '验证码已失效，请重新获取', 400);
  }
  if (record.locked_until !== null && record.locked_until > now) {
    throw new ApiException('code_locked', '验证码错误次数过多，请 10 分钟后再试', 429);
  }
  if (record.expires_at <= now) {
    throw new ApiException('code_expired', '验证码已过期，请重新获取', 400);
  }

  if (record.code !== code) {
    const attempts = record.attempts + 1;
    const locked = attempts >= RATE_LIMITS.maxAttempts;
    await c.env.DB.prepare('UPDATE phone_codes SET attempts = ?, locked_until = ? WHERE phone = ?')
      .bind(locked ? 0 : attempts, locked ? now + RATE_LIMITS.lockMs : null, phone)
      .run();
    if (locked) {
      throw new ApiException('code_locked', '验证码错误次数过多，请 10 分钟后再试', 429);
    }
    throw new ApiException('invalid_code', '验证码不正确', 400);
  }

  // 一码一用：校验通过立刻删除，杜绝重放
  await c.env.DB.prepare('DELETE FROM phone_codes WHERE phone = ?').bind(phone).run();

  let user = await c.env.DB.prepare('SELECT * FROM users WHERE phone = ?')
    .bind(phone)
    .first<UserRow>();
  let tenantId: string;

  if (user) {
    await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(now, user.id)
      .run();
    const membership = await c.env.DB.prepare(
      'SELECT tenant_id FROM tenant_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1',
    )
      .bind(user.id)
      .first<{ tenant_id: string }>();
    if (!membership) {
      throw new ApiException('internal', '账号数据异常，请联系管理员', 500);
    }
    tenantId = membership.tenant_id;
    user.last_login_at = now;
  } else {
    // 首次登录：同一批次建 user + tenant + tenant_members，避免半成品账号
    const userId = newId('usr');
    const tenantIdNew = newId('tnt');
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users (id, phone, nickname, avatar_url, created_at, last_login_at) VALUES (?, ?, NULL, NULL, ?, ?)',
      ).bind(userId, phone, now, now),
      c.env.DB.prepare(
        'INSERT INTO tenants (id, name, owner_id, plan, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(tenantIdNew, '个人空间', userId, 'free', now),
      c.env.DB.prepare(
        'INSERT INTO tenant_members (tenant_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      ).bind(tenantIdNew, userId, 'owner', now),
    ]);
    user = {
      id: userId,
      phone,
      nickname: null,
      avatar_url: null,
      created_at: now,
      last_login_at: now,
    };
    tenantId = tenantIdNew;
  }

  const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<TenantRow>();
  if (!tenant) {
    throw new ApiException('internal', '账号数据异常，请联系管理员', 500);
  }

  // 64 字符 hex = 32 字节随机
  const token = randomHex(32);
  await c.env.DB.prepare(
    'INSERT INTO sessions (token, user_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(token, user.id, tenantId, now, now + RATE_LIMITS.sessionTtlMs)
    .run();

  return ok(c, { token, user: toUserDTO(user), tenant: toTenantDTO(tenant) });
});

/** GET /api/v1/auth/me */
authRoutes.get('/me', requireSession, (c) => {
  const { user, tenant } = c.get('auth');
  return ok(c, { user, tenant });
});

/** POST /api/v1/auth/logout */
authRoutes.post('/logout', requireSession, async (c) => {
  const { token } = c.get('auth');
  await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return ok(c, {});
});
