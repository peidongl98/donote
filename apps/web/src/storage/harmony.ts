/**
 * 鸿蒙壳的传输层。
 *
 * ArkWeb 里页面是从 HAP 的 rawfile 读的，origin 是 null；而 WebDAV 服务（坚果云等）
 * 不返回 CORS 响应头，网页里直接 fetch 一定是 Failed to fetch —— 也就是用户看到的
 * 「连不上这个地址」。桌面端用 Tauri 的 Rust reqwest 绕开，鸿蒙这边由壳注入
 * `window.DoNoteNative.davRequest()`（@ohos.net.http），这里把它接成 DavFetch。
 *
 * 协议只有四个字符串参数、一个 JSON 字符串返回，语义全留在网页侧 ——
 * 与桌面端共用同一份 WebDAV 解析代码。
 */
import { toBase64 } from '@/utils/base64';
import { setDavFetch } from './transport';

/** 壳里注入的对象。字段可能不存在（老版本壳 / 浏览器），所以全部按可选处理 */
interface HarmonyBridge {
  davRequest?: (
    url: string,
    method: string,
    headersJson: string,
    bodyB64: string,
  ) => Promise<string>;
  /** 同步返回 phone / tablet / 2in1 / wearable / tv */
  deviceType?: () => string;
  /** 同步返回 "top,bottom"（vp），壳还没量到时为 null */
  safeInsets?: () => string;
}

interface BridgeReply {
  status: number;
  headers: string;
  bodyB64: string;
  error?: string;
}

function injected(): HarmonyBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { DoNoteNative?: HarmonyBridge }).DoNoteNative ?? null;
}

function nativeBridge(): HarmonyBridge['davRequest'] | null {
  const host = injected();
  const fn = host?.davRequest;
  return typeof fn === 'function' ? fn.bind(host) : null;
}

/**
 * 把设备形态写到 <html>，CSS 靠它选移动端排版。
 *
 * 为什么不看视口宽度：实测这台平板是 920 CSS px（DPR = 2），和一台拖窄的桌面窗口
 * 完全重叠，靠宽度分不开；分错的代价是一边字大得离谱、另一边还是小字。
 * 壳知道自己在什么设备上，直接问它。同步调用，首帧就能带上属性，不会先闪一下桌面布局。
 */
function markDevice(): void {
  let type = '';
  try {
    type = injected()?.deviceType?.() ?? '';
  } catch {
    type = '';
  }
  if (!type) return;
  const el = document.documentElement;
  el.setAttribute('data-device', type);
  /*
   * 只有手机和平板要「触控尺寸 + 放大字号」。
   * 2in1（鸿蒙 PC）是有键盘鼠标的大屏，按桌面排版更合适 —— 那里窗口宽度也够。
   */
  if (type === 'phone' || type === 'tablet') {
    el.setAttribute('data-touch', '1');
  }

  /*
   * 安全区。窗口是全屏的（见 EntryAbility），ArkWeb 又不填 env(safe-area-inset-*)，
   * 所以只能问壳。壳那边 getLastWindow 是异步的，首帧常常还没量完 —— 这里读到空就跳过，
   * 壳在 onPageEnd 之后会自己再灌一次同样的变量（Index.ets 的 pushInsets）。
   */
  let insets = '';
  try {
    insets = injected()?.safeInsets?.() ?? '';
  } catch {
    insets = '';
  }
  if (!insets) return;
  const [top, bottom] = insets.split(',');
  if (Number.isFinite(Number(top))) el.style.setProperty('--safe-top', `${Number(top)}px`);
  if (Number.isFinite(Number(bottom))) el.style.setProperty('--safe-bottom', `${Number(bottom)}px`);
}

export function isHarmonyRuntime(): boolean {
  return nativeBridge() !== null;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 请求体统一成 ArrayBuffer。WebDAV 这边只可能出现 string / ArrayBuffer / Uint8Array / Blob */
async function bodyToBuffer(body: RequestInit['body']): Promise<ArrayBuffer> {
  // 先落到 unknown：BodyInit 的联合类型里 Blob 与 Uint8Array 都有 slice()，
  // 直接在原类型上窄化会让 TS 把两侧混成一个不存在的 'Blob | Uint8Array' 成员
  const raw: unknown = body;
  if (raw == null) return new Uint8Array(0).buffer as ArrayBuffer;
  if (typeof raw === 'string') return new TextEncoder().encode(raw).buffer as ArrayBuffer;
  if (raw instanceof ArrayBuffer) return raw;
  // Uint8Array 可能只是更大 buffer 的一段视图，slice 出来才是干净的一块
  if (raw instanceof Uint8Array) return raw.slice().buffer as ArrayBuffer;
  if (typeof Blob !== 'undefined' && raw instanceof Blob) return await raw.arrayBuffer();
  return new TextEncoder().encode(String(raw)).buffer as ArrayBuffer;
}

/**
 * 把传输层换成原生桥。不在鸿蒙壳里跑时返回 false，什么都不改。
 * 必须在第一次发请求之前调用（main.ts 里紧跟 installTauriBridge）。
 */
export function installHarmonyBridge(): boolean {
  // 先标设备形态：后面即使桥用不了（老壳），排版也该是移动端那套
  markDevice();

  const request = nativeBridge();
  if (!request) return false;

  setDavFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });

    const body = init.body == null ? '' : toBase64(await bodyToBuffer(init.body));
    const raw = await request(url, (init.method ?? 'GET').toUpperCase(), JSON.stringify(headers), body);

    let reply: BridgeReply;
    try {
      reply = JSON.parse(raw) as BridgeReply;
    } catch {
      throw new TypeError('鸿蒙网络桥返回了无法解析的内容');
    }
    // status=0 是壳里 http 模块抛错（DNS / TLS / 超时），不是 HTTP 响应
    if (!reply.status) throw new TypeError(`连不上服务器（${reply.error ?? '网络不可达'}）`);

    const outHeaders = new Headers();
    try {
      const parsed = JSON.parse(reply.headers || '{}') as Record<string, string>;
      for (const key of Object.keys(parsed)) outHeaders.set(key, String(parsed[key]));
    } catch {
      // 头丢了不影响状态码判断，正文照常返回
    }

    const bytes = reply.bodyB64 ? base64ToBytes(reply.bodyB64) : null;
    // 204 / 304 带 body 会被 Response 构造器拒绝
    const noBody = reply.status === 204 || reply.status === 304 || bytes === null;
    // base64ToBytes 建的是精确长度的新数组，整块 buffer 就是这条消息
    const payload = bytes === null ? null : (bytes.buffer as ArrayBuffer);
    return new Response(noBody ? null : payload, { status: reply.status, headers: outHeaders });
  });

  return true;
}
