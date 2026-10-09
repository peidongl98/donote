import { createMiddleware } from 'hono/factory';
import { PHONE_PATTERN, RATE_LIMITS } from '@donote/shared';
import type { AppEnv } from '../env';
import { ApiException } from '../utils/response';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * 短信发送防刷（三条阈值都基于 sms_logs，只查索引命中列）：
 *   1. 同手机号 60 秒内 1 次
 *   2. 同手机号 24 小时内 ≤ 10 次
 *   3. 同 IP 1 小时内 ≤ 20 次
 * 通过后把手机号放进 context，供 send-code 处理器复用。
 */
export const smsRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const body = await c.req
    .json<{ phone?: unknown }>()
    .catch(() => null);
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';

  if (!PHONE_PATTERN.test(phone)) {
    throw new ApiException('invalid_phone', '请输入正确的 11 位手机号', 400);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();

  const last = await c.env.DB.prepare(
    'SELECT created_at FROM sms_logs WHERE phone = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(phone)
    .first<{ created_at: number }>();

  if (last && now - last.created_at < RATE_LIMITS.sendIntervalSec * 1000) {
    const wait = Math.ceil(
      (RATE_LIMITS.sendIntervalSec * 1000 - (now - last.created_at)) / 1000,
    );
    c.header('Retry-After', String(wait));
    throw new ApiException('rate_limited', `请求过于频繁，请 ${wait} 秒后再试`, 429);
  }

  const phoneRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM sms_logs WHERE phone = ? AND created_at > ?',
  )
    .bind(phone, now - DAY_MS)
    .first<{ total: number }>();

  if ((phoneRow?.total ?? 0) >= RATE_LIMITS.phoneDailyMax) {
    throw new ApiException('rate_limited', '该手机号今日发送次数已达上限', 429);
  }

  const ipRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM sms_logs WHERE ip = ? AND created_at > ?',
  )
    .bind(ip, now - HOUR_MS)
    .first<{ total: number }>();

  if ((ipRow?.total ?? 0) >= RATE_LIMITS.ipHourlyMax) {
    throw new ApiException('rate_limited', '当前网络请求过于频繁，请稍后再试', 429);
  }

  c.set('sendCodePhone', phone);
  await next();
});
