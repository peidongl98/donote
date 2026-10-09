import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriRuntime, setDavFetch } from './transport';
import { setSecretStore } from './secret-store';

interface SecretPayload {
  value: string | null;
}

/**
 * 把传输层与凭据存储换成端上的原生实现。必须在挂载前调用一次。
 * 不在 Tauri 里跑时直接返回 false，什么都不改。
 */
export function installTauriBridge(): boolean {
  if (!isTauriRuntime()) return false;

  // 请求走 Rust reqwest，不经浏览器网络栈 → 不受坚果云 CORS 限制
  setDavFetch((url, init) => tauriFetch(url, init) as unknown as Promise<Response>);

  // 凭据进 Windows 凭据管理器，不落磁盘明文
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

  return true;
}
