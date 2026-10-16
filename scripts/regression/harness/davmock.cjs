/**
 * 同源假 WebDAV —— 一个跑在进程内、不花坚果云额度的内存文件系统。
 *
 * 为什么要两条入口（见 harness/probe-routing.cjs 的实测结论）：
 *   ① 页面里的应用请求：dev 下坚果云地址被改写成同源 `/nutdav/dav`，
 *      `page.route('**\/nutdav/**')` 能接住（实测命中）。
 *   ② 套件自己的「服务端核对」：直接 `ctx.request.fetch('https://dav.jianguoyun.com/...')`，
 *      **`context.route` 拦不到它**（实测 ctxRouteHit=0，请求真的发出去了），
 *      只能在 harness 里改写 `ctx.request.fetch`（实测可安全改写）。
 *
 * 两条入口共用同一个 NODES，所以「套件核对服务端」与「界面看到的内容」永远一致。
 *
 * 与坚果云对齐的行为：
 *   · `Depth: infinity` 降级成 1（坚果云就是这么干的，也是「冷启动 1 次请求」做不到的原因）
 *   · 目录的 getetag 是空元素，文件给真 etag
 *   · getlastmodified 是 HTTP-date（秒级）
 */

const MOUNT = '/nutdav'; // dev 下应用实际打的前缀
const BASE_PATH = '/dav'; // 服务器根路径
const ROOT = '/DoNote'; // 同步根
const PREFIX_PATH = BASE_PATH + ROOT; // 套件核对用的路径前缀 /dav/DoNote
const PREFIX_URL = MOUNT + PREFIX_PATH; // 应用实际打的前缀 /nutdav/dav/DoNote

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------ 内存文件系统 ------------------------------ */

let etagSeq = 0;
const NODES = new Map(); // rel -> { dir:true, mtime } | { dir:false, body:Buffer, etag, mtime }

const nowMs = () => Date.now();

function mkdir(rel) {
  NODES.set(rel, { dir: true, mtime: nowMs() });
}
function mkfile(rel, body, mtime) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  NODES.set(rel, { dir: false, body: buf, etag: `mock-${++etagSeq}`, mtime: mtime ?? nowMs() });
}

/** 确定性种子：**空保险库 + 空的 .trash**，其余内容全由套件自己造。 */
function seed() {
  NODES.clear();
  etagSeq = 0;
  mkdir('');
  mkdir('.trash');
}

/**
 * 往保险库里塞一篇格式正确的笔记（文件名 = 标题，与「标题即文件名」的约定一致）。
 * 给需要「列表里先有东西」的验收脚本用。
 */
function putNote(name, body) {
  const t = Date.now() - 3_600_000;
  const text = [
    '---',
    `title: ${JSON.stringify(name)}`,
    `created: ${t}`,
    `updated: ${t}`,
    'tags: []',
    '---',
    '',
    body ?? `${name} 的正文。`,
    '',
  ].join('\n');
  mkfile(`${name}.md`, text, t);
}

function childRels(dir) {
  const prefix = dir ? `${dir}/` : '';
  const out = [];
  for (const rel of NODES.keys()) {
    if (!rel || !rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    if (!rest || rest.includes('/')) continue;
    out.push(rel);
  }
  return out.sort();
}

/** 把 URL 路径换算成保险库内的相对路径。认不出来（不是本服务器）返回 null。 */
function relFromPathname(pathname) {
  let rest = null;
  if (pathname.startsWith(PREFIX_URL)) rest = pathname.slice(PREFIX_URL.length);
  else if (pathname.startsWith(PREFIX_PATH)) rest = pathname.slice(PREFIX_PATH.length);
  if (rest === null) return null;
  let rel = rest;
  try {
    rel = decodeURIComponent(rest);
  } catch {
    /* 保持原样 */
  }
  return rel.replace(/^\/+|\/+$/g, '');
}

/**
 * MOVE 的 Destination 头。
 * ⚠️ 应用拼的是 `originUrl()` —— **绝对地址、指向真坚果云主机**（注释写明「Destination 必须是绝对地址，
 * 因此不能复用 dev 下的同源代理前缀」），而请求本身走的是同源 /nutdav。所以这里必须先取 pathname 再算 rel，
 * 直接拿整串去比前缀只会得到 null（早期版本就是这么 400 的）。
 */
function relFromDestination(value) {
  if (!value) return null;
  let pathname = String(value);
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    /* 相对地址：本身就是路径 */
  }
  return relFromPathname(pathname);
}

/* ------------------------------ 响应拼装 ------------------------------ */

const xmlEscape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hrefOf(rel, isDir) {
  const encoded = rel ? rel.split('/').map(encodeURIComponent).join('/') : '';
  const path = encoded ? `${PREFIX_PATH}/${encoded}` : `${PREFIX_PATH}/`;
  return isDir && !path.endsWith('/') ? `${path}/` : path;
}

function entryXml(rel) {
  const node = NODES.get(rel);
  if (!node) return '';
  const isDir = Boolean(node.dir);
  const lastMod = `<d:getlastmodified>${new Date(node.mtime).toUTCString()}</d:getlastmodified>`;
  const props = isDir
    ? `<d:resourcetype><d:collection/></d:resourcetype>${lastMod}<d:getetag/>`
    : `<d:resourcetype/>${lastMod}<d:getetag>${xmlEscape(node.etag)}</d:getetag>` +
      `<d:getcontentlength>${node.body.length}</d:getcontentlength>` +
      `<d:getcontenttype>${MIME[extOf(rel)] ?? 'application/octet-stream'}</d:getcontenttype>`;
  return (
    `<d:response><d:href>${xmlEscape(hrefOf(rel, isDir))}</d:href>` +
    `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

function extOf(rel) {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i).toLowerCase();
}

function multistatus(rels) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:">' +
    rels.map(entryXml).join('') +
    '</d:multistatus>'
  );
}

/* ------------------------------ 协议实现 ------------------------------ */

const XML_HEADERS = { 'content-type': 'application/xml; charset=utf-8' };

/**
 * 故障注入（只在验收里用）。规则返回 0 = 不拦，返回状态码 = 直接用这个状态码应答。
 * 例：让 DELETE 某条笔记回 503，验证批量的「限流即停」。
 * 返回值也可以给 `{ status, headers }` —— 注入 `Retry-After` 只能这样给。
 */
let failWhen = null;
function injectFailure(rule) {
  failWhen = rule;
}

/**
 * 唯一的协议实现。页面入口和 fetch 改写入口都走这里。
 * @returns {{status:number, headers:Record<string,string>, body:Buffer|string}}
 */
function serve(rel, req = {}) {
  const method = (req.method || 'GET').toUpperCase();
  const depth = String(req.depth ?? '0').toLowerCase();
  const node = NODES.get(rel);

  if (failWhen) {
    const injected = failWhen(method, rel);
    if (injected) {
      // 数字 = 只改状态码；对象 = 连响应头一起给（注入 Retry-After 用）
      const spec = typeof injected === 'object' ? injected : { status: injected };
      return { status: spec.status, headers: spec.headers ?? {}, body: spec.body ?? '' };
    }
  }

  if (method === 'OPTIONS') {
    return {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*',
        dav: '1,2',
      },
      body: '',
    };
  }

  if (method === 'PROPFIND') {
    if (!node) return { status: 404, headers: XML_HEADERS, body: '' };
    if (depth === '0') return { status: 207, headers: XML_HEADERS, body: multistatus([rel]) };
    // 与坚果云一致：infinity 降级成 1
    return { status: 207, headers: XML_HEADERS, body: multistatus([rel, ...childRels(rel)]) };
  }

  if (method === 'HEAD' || method === 'GET') {
    if (!node || node.dir) return { status: 404, headers: {}, body: '' };
    const headers = {
      'content-type': MIME[extOf(rel)] ?? 'application/octet-stream',
      'content-length': String(node.body.length),
      etag: `"${node.etag}"`,
      'last-modified': new Date(node.mtime).toUTCString(),
    };
    return { status: 200, headers, body: method === 'HEAD' ? '' : node.body };
  }

  if (method === 'PUT') {
    const existed = Boolean(node && !node.dir);
    if (node && node.dir) return { status: 405, headers: {}, body: '' };
    mkfile(rel, req.body ?? '');
    return { status: existed ? 204 : 201, headers: { etag: `"${NODES.get(rel).etag}"` }, body: '' };
  }

  if (method === 'MKCOL') {
    // 对**已存在的集合**再 MKCOL：按 RFC 该回 405，但坚果云不报错。
    // 证据：真实模式跑 9 套的日志里 `405` 出现次数为 0，而应用的 `ensureDir()` 是无条件
    // 逐段 MKCOL、`mkdir()` 同时容忍 201/405 —— 也就是说它每次都在对已存在目录 MKCOL，
    // 真服务器却没回 405。这里跟随坚果云回 201，否则界面上会多出一条控制台错误，
    // 让「无预期外的控制台错误」在 mock 下假失败。
    if (!node) mkdir(rel);
    return { status: 201, headers: {}, body: '' };
  }

  if (method === 'DELETE') {
    if (!node) return { status: 404, headers: {}, body: '' };
    for (const key of [...NODES.keys()]) {
      if (key === rel || key.startsWith(`${rel}/`)) NODES.delete(key);
    }
    return { status: 204, headers: {}, body: '' };
  }

  if (method === 'MOVE') {
    if (!node) return { status: 404, headers: {}, body: '' };
    const dest = relFromDestination(req.destination);
    if (dest === null) {
      if (process.env.MOCK_LOG === '1') {
        console.log(`    [mock] MOVE Destination 解析不了：${JSON.stringify(req.destination ?? null)}`);
      }
      return { status: 400, headers: {}, body: '' };
    }
    const overwrite = String(req.overwrite ?? 'T').toUpperCase() !== 'F';
    const destExists = NODES.has(dest);
    if (destExists && !overwrite) return { status: 412, headers: {}, body: '' };
    if (destExists) {
      for (const key of [...NODES.keys()]) {
        if (key === dest || key.startsWith(`${dest}/`)) NODES.delete(key);
      }
    }
    const moved = [];
    for (const key of [...NODES.keys()]) {
      if (key === rel || key.startsWith(`${rel}/`)) {
        moved.push([dest + key.slice(rel.length), NODES.get(key)]);
        NODES.delete(key);
      }
    }
    for (const [key, value] of moved) NODES.set(key, value);
    return { status: destExists ? 204 : 201, headers: {}, body: '' };
  }

  return { status: 400, headers: {}, body: '' };
}

/* ------------------------------ 接进 Playwright ------------------------------ */

const counters = new Map();
const PATCHED = Symbol('donote.davmock.patched');

function count(method) {
  counters.set(method, (counters.get(method) ?? 0) + 1);
}

/** 应用侧入口：接住页面里打到 /nutdav 的所有请求 */
async function routeHandler(route) {
  const req = route.request();
  const method = req.method().toUpperCase();
  count(method);
  const rel = relFromPathname(new URL(req.url()).pathname);
  if (rel === null) return route.continue();
  return tracked(async () => {
    if (delayMs) await sleep(delayMs);
    const out = serve(rel, {
      method,
      depth: req.headers()['depth'],
      destination: req.headers()['destination'],
      overwrite: req.headers()['overwrite'],
      body: req.postDataBuffer() ?? '',
    });
    if (process.env.MOCK_LOG === '1') {
      console.log(`    [mock] ${method} ${rel || '/'} -> ${out.status}`);
    }
    return route.fulfill({ status: out.status, headers: out.headers, body: out.body });
  });
}

/** 套件侧入口：把 ctx.request.fetch 换成读同一份内存文件系统 */
function patchRequest(ctx) {
  const request = ctx.request;
  if (request[PATCHED]) return;
  const original = request.fetch.bind(request);
  request.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' ? url : (url && url.url) || '';
    let parsed = null;
    try {
      parsed = new URL(target);
    } catch {
      return original(url, init);
    }
    // 只接管指向测试坚果云地址的请求；别的照常放行
    if (parsed.host !== 'dav.jianguoyun.com') return original(url, init);
    const rel = relFromPathname(parsed.pathname);
    if (rel === null) return original(url, init);
    const headers = init.headers ?? {};
    const method = (init.method || 'GET').toUpperCase();
    count(method);
    const out = serve(rel, {
      method,
      depth: headers.Depth ?? headers.depth,
      destination: headers.Destination ?? headers.destination,
      overwrite: headers.Overwrite ?? headers.overwrite,
      body: init.data ?? init.body ?? '',
    });
    if (process.env.MOCK_LOG === '1') {
      console.log(`    [mock:direct] ${method} ${rel || '/'} -> ${out.status}`);
    }
    const buf = Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body ?? ''), 'utf8');
    return {
      status: () => out.status,
      statusText: () => '',
      ok: () => out.status >= 200 && out.status < 300,
      url: () => target,
      headers: () => ({ ...out.headers }),
      headersArray: () => Object.entries(out.headers).map(([name, value]) => ({ name, value })),
      text: async () => buf.toString('utf8'),
      body: async () => buf,
      json: async () => JSON.parse(buf.toString('utf8')),
      dispose: async () => {},
      [Symbol.asyncDispose]: async () => {},
    };
  };
  request[PATCHED] = true;
}

/** 给一个 page + 它的 context 装上假 DAV。可重复调用。 */
async function install(page, ctx) {
  await page.route('**/nutdav/**', routeHandler);
  patchRequest(ctx);
}

function stats() {
  return Object.fromEntries([...counters.entries()].sort());
}

/* ---------------- 时序观测设施（验收「闸门」「退避」时用） ---------------- */

/**
 * 人为延迟（毫秒），默认 0。
 *
 * 秒回的假 DAV 看不出「并发 1」和「并发 5」的区别 —— 请求还没叠上就结束了。
 * 给它加一点延迟，在途请求才会真的重叠，闸门有没有把并发压成 1 才测得出。
 * 只在验收里用，正常套件不要设。
 */
let delayMs = 0;
let inflight = 0;
let peakInflight = 0;

function setDelay(ms) {
  delayMs = ms;
}

/** 把「在途」计数包在一次请求处理外面。并发一叠上来 peakInflight 就会 >1 */
async function tracked(fn) {
  inflight++;
  if (inflight > peakInflight) peakInflight = inflight;
  try {
    return await fn();
  } finally {
    inflight--;
  }
}

/** 观测窗口：峰值在途数、当前在途数 */
function timing() {
  return { peakInflight, inflight };
}

function resetTiming() {
  peakInflight = 0;
  inflight = 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  seed, putNote, mkdir, mkfile, install, serve, stats, injectFailure,
  relFromPathname, relFromDestination, hrefOf, NODES, PREFIX_PATH,
  setDelay, timing, resetTiming,
};
