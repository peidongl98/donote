/**
 * Pages Function：把本站 /api/* 同源反代到独立部署的 Worker。
 *
 * 为什么需要这一层：
 *   本机网络无法访问 *.workers.dev（实测该域返回连接失败，pages.dev 正常），
 *   若前端直接跨域调 Worker，用户侧会整站不可用。
 *   经此代理后，前后端同源：不依赖 workers.dev 的可达性，也彻底不需要 CORS。
 *
 * 后端仍然是独立的 Worker（noteapp-api），本函数只负责转发，不含业务逻辑。
 * 超时/重试等策略不在此处实现，保持单一职责。
 */

const API_ORIGIN = 'https://noteapp-api.peidongl98.workers.dev';

export const onRequest: PagesFunction = async (context) => {
  const incoming = new URL(context.request.url);
  const target = new URL(incoming.pathname + incoming.search, API_ORIGIN);

  // 直接沿用原请求（方法、头、body），只换目标 URL
  const proxied = new Request(target.toString(), context.request);

  // 保留真实访客 IP，供 Worker 侧按 IP 做短信防刷
  const clientIp = context.request.headers.get('CF-Connecting-IP');
  if (clientIp) proxied.headers.set('CF-Connecting-IP', clientIp);

  return fetch(proxied);
};
