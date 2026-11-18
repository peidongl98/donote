/**
 * ArrayBuffer → base64。分块转，别把几十万个参数一次性 apply 进 fromCharCode
 * （大图、docx 包动辄几 MB，一次展开会直接爆栈）。
 */
export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
