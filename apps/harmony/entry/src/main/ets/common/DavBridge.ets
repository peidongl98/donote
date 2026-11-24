import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { deviceInfo } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * WebDAV 请求的原生出口。
 *
 * 为什么必须有这一层：ArkWeb 里页面 origin 是 null（从 rawfile 读的），
 * 而坚果云这类 WebDAV 服务不返回 CORS 响应头 → 网页里 `fetch('https://dav.jianguoyun.com/...')`
 * 一律 Failed to fetch。桌面端靠 Tauri 的 Rust reqwest 绕开，鸿蒙这边就只能靠
 * `@ohos.net.http` 发出去，再把响应原样搬回网页。
 *
 * 接口形状刻意做得很薄：收 base64、吐 base64，不做任何 WebDAV 语义处理，
 * 也不需要认得 207 / PROPFIND。这样解析仍在网页侧（与桌面端同一份代码）。
 */
interface BridgeReply {
  status: number;
  headers: string;
  bodyB64: string;
  error?: string;
}

/** 请求头 JSON → string 字典。值统一转字符串，http 模块只认 string */
function parseHeaders(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!json) return out;
  try {
    const parsed = JSON.parse(json) as Record<string, Object>;
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (value === null || value === undefined) continue;
      out[key] = String(value);
    }
  } catch (e) {
    // 头解析失败就当没带，让服务端自己报 401 —— 比整条请求失败好排查
  }
  return out;
}

export class DavBridge {
  private helper: util.Base64Helper = new util.Base64Helper();
  /** 全屏窗口下状态栏 / 手势条压掉的高度（vp），由 Index 页面量好后写进来 */
  private insetTop: number = 0;
  private insetBottom: number = 0;

  setInsets(top: number, bottom: number): void {
    this.insetTop = top;
    this.insetBottom = bottom;
  }

  /**
   * 给网页用的安全区读数，形如 "24,16"（vp）。还没量到就返回空串。
   *
   * ArkWeb 不填 CSS 的 env(safe-area-inset-*)，而窗口是全屏的（EntryAbility），
   * 不自己告诉页面就会让标题压到状态栏上。
   */
  safeInsets(): string {
    if (this.insetTop <= 0 && this.insetBottom <= 0) return '';
    return `${this.insetTop},${this.insetBottom}`;
  }

  /**
   * 本机形态：phone / tablet / 2in1 / wearable / tv …
   *
   * 网页侧拿它决定「要不要按移动端排版」，而不是自己猜视口宽度 —— 实测这台平板
   * 是 920 CSS px（DPR=2），和一台窄的桌面窗口完全重叠，靠宽度分不开。
   * 同步返回，网页首帧就能用上，不会先闪一下桌面布局。
   */
  deviceType(): string {
    return deviceInfo.deviceType;
  }

  /**
   * @param url 完整地址（含 https:// 与路径）
   * @param method WebDAV 方法。PROPFIND / MKCOL / MOVE 不在 RequestMethod 枚举里，
   *               但底层就是字符串，断言透传即可
   * @param headersJson 请求头，JSON 对象
   * @param bodyB64 请求体 base64；空串表示没有体（GET / DELETE / PROPFIND）
   * @returns JSON 字符串：{status, headers, bodyB64}，失败时 status=0 并带 error
   */
  async davRequest(url: string, method: string, headersJson: string, bodyB64: string): Promise<string> {
    const request = http.createHttp();
    const options: http.HttpRequestOptions = {
      method: method as http.RequestMethod,
      header: parseHeaders(headersJson),
      // 一律按二进制收：markdown 是 utf-8、图片是二进制，同一套处理不会把中文弄坏
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: 20000,
      // 网盘被限流时会挂很久，超时给足，否则用户看到的是"莫名失败"
      readTimeout: 60000,
      usingCache: false,
    };
    if (bodyB64.length > 0) {
      // extraData 只认 string / ArrayBuffer，传 Uint8Array 会被当普通对象忽略。
      // 用 slice 而不是直接 .buffer：TypedArray 可能只是更大 buffer 的一段视图，
      // 交出去会把多余字节一起发上去（markdown 会因此被污染）。
      const decoded = this.helper.decodeSync(bodyB64);
      options.extraData = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
    }

    try {
      const res = await request.request(url, options);
      let body = '';
      if (res.result instanceof ArrayBuffer) {
        body = this.helper.encodeToStringSync(new Uint8Array(res.result));
      }
      const reply: BridgeReply = {
        status: res.responseCode,
        headers: JSON.stringify(res.header),
        bodyB64: body,
      };
      return JSON.stringify(reply);
    } catch (err) {
      const e = err as BusinessError;
      const reply: BridgeReply = {
        status: 0,
        headers: '{}',
        bodyB64: '',
        error: `code=${e.code} ${e.message}`,
      };
      console.error(`WEBERR dav ${url} ${reply.error}`);
      return JSON.stringify(reply);
    } finally {
      request.destroy();
    }
  }
}
