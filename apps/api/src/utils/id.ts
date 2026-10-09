const HEX = '0123456789abcdef';

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/** 主键：8 字节时间前缀 + 8 字节随机，避免 D1 上随机主键写入热点 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomHex(8)}`;
}

/** 6 位数字验证码，均匀分布（拒绝采样避免取模偏置） */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1000000) * 1000000;
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(value % 1000000).padStart(6, '0');
}

/** 分享密码等一次性凭证的哈希：不存明文，比对时现算 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let out = '';
  for (const byte of new Uint8Array(digest)) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}
