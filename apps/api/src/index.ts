import { Hono } from 'hono';
import type { AppEnv } from './env';
import { corsMiddleware } from './middleware/cors';
import { authRoutes } from './routes/auth';
import { ApiException, fail, ok } from './utils/response';

const app = new Hono<AppEnv>();

app.use('*', corsMiddleware());

/** 健康检查：部署后用于核验 Worker 是否带着正确环境变量上线 */
app.get('/api/v1/health', (c) =>
  ok(c, { env: c.env.ENVIRONMENT, time: Date.now() }),
);

app.route('/api/v1/auth', authRoutes);

app.notFound((c) => fail(c, 'not_found', '接口不存在', 404));

app.onError((err, c) => {
  if (err instanceof ApiException) {
    return fail(c, err.code, err.message, err.status);
  }
  console.error('[noteapp-api] unhandled', err);
  return fail(c, 'internal', '服务器内部错误', 500);
});

export default app;
