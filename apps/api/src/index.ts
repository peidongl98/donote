import { Hono } from 'hono';
import type { AppEnv } from './env';
import { corsMiddleware } from './middleware/cors';
import { authRoutes } from './routes/auth';
import { folderRoutes } from './routes/folders';
import { noteRoutes } from './routes/notes';
import { publicShareRoutes, shareRoutes } from './routes/shares';
import { ApiException, fail, ok } from './utils/response';

const app = new Hono<AppEnv>();

app.use('*', corsMiddleware());

/**
 * 所有 API 响应禁止缓存。
 * 起因：410 Gone 属于可被浏览器启发式缓存的状态码 —— 笔记删除后访客拿到 410，
 * 之后再恢复，访客刷新仍会看到「内容已删除」（实测复现）。加上 no-store 根治。
 */
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

/** 健康检查：部署后用于核验 Worker 是否带着正确环境变量上线 */
app.get('/api/v1/health', (c) =>
  ok(c, { env: c.env.ENVIRONMENT, time: Date.now() }),
);

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/notes', noteRoutes);
app.route('/api/v1/folders', folderRoutes);
app.route('/api/v1/shares', shareRoutes);
// 公开分享：匿名可访问，不挂 session 中间件
app.route('/api/v1/public/shares', publicShareRoutes);

app.notFound((c) => fail(c, 'not_found', '接口不存在', 404));

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return fail(c, err.code, err.message, err.status);
  }
  console.error('[donote-api] unhandled', err);
  return fail(c, 'internal', '服务器内部错误', 500);
});

export default app;
