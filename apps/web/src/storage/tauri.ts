import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isMobileShell, isTauriRuntime, markTouchDevice, setDavFetch } from './transport';
import { setSecretStore } from './secret-store';

interface SecretPayload {
  value: string | null;
}

/**
 * 移动端排版开关。
 *
 * 鸿蒙壳由原生侧上报 deviceInfo.deviceType（见 storage/harmony.ts），Tauri 这边没有那条
 * 通道，只能自己判一次：UA 认移动端，再按短边宽度分手机 / 平板。
 * 写属性这件事收在 markTouchDevice 里，浏览器直连走的是同一份实现。
 */
function markMobileShell(): void {
  if (!isMobileShell()) return;
  markTouchDevice();
}

/**
 * 把传输层与凭据存储换成端上的原生实现。必须在挂载前调用一次。
 * 不在 Tauri 里跑时直接返回 false，什么都不改。
 */
export function installTauriBridge(): boolean {
  if (!isTauriRuntime()) return false;

  markMobileShell();

  // 请求走 Rust reqwest，不经浏览器网络栈 → 不受 WebDAV 服务的跨域限制
  // （远端域名由 src-tauri/capabilities/default.json 放行）
  setDavFetch((url, init) => tauriFetch(url, init) as unknown as Promise<Response>);

  // 凭据进 Windows 凭据管理器，不落磁盘明文。
  // Android 没有系统钥匙串（Rust 侧同名命令只是空实现），那边继续用 WebView 自己的
  // localStorage —— 它在应用私有目录里，别的应用读不到，重启也不会丢。
  if (!isMobileShell()) {
    setSecretStore({
      async read(key: string) {
        const res = await invoke<SecretPayload>('secret_read', { key });
        return res?.value ?? null;
      },
      async write(key: string, value: string) {
        await invoke('secret_write', { key, value });
      },
      async clear(key: string) {
        await invoke('secret_clear', { key });
      },
    });
  }

  return true;
}
