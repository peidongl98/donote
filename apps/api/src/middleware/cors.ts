import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { AppEnv } from '../env';

/**
 * CORS 白名单分环境：只认 ALLOWED_ORIGINS 里列出的来源。
 * dev  → http://localhost:5173, http://127.0.0.1:5173（同时配了 Vite 同源代理）
 * prod → 线上 Pages 域名
 * 不在名单内不回 ACAO 头，浏览器直接拦截。
 */
export function corsMiddleware() {
  return cors({
    origin: (origin: string, c: Context<AppEnv>) => {
      const list = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      return list.includes(origin) ? origin : undefined;
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  });
}
