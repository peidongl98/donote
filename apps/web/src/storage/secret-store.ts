/**
 * 凭据存储抽象 —— 按运行环境切换实现。
 *
 *   浏览器（仅开发调试）→ localStorage
 *   Windows 桌面端        → Windows 凭据管理器（见 storage/tauri.ts）
 *   iOS                  → Keychain（待接入）
 *   鸿蒙                  → @kit.AssetStoreKit（待接入）
 */
export interface SecretStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

const webSecretStore: SecretStore = {
  async read(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async write(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 隐私模式 / 配额满：写不进去也不该让连接流程失败
    }
  },
  async clear(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 同上 */
    }
  },
};

let impl: SecretStore = webSecretStore;

export function setSecretStore(next: SecretStore): void {
  impl = next;
}

export const secretStore: SecretStore = {
  read: (key) => impl.read(key),
  write: (key, value) => impl.write(key, value),
  clear: (key) => impl.clear(key),
};
