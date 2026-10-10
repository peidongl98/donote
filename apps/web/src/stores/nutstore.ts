import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { secretStore } from '@/storage/secret-store';
import {
  DEFAULT_ROOT,
  JianguoYunAdapter,
  setStorage,
  StorageError,
  type StorageConfig,
} from '@/services/storage';

const SECRET_KEY = 'donote.nutstore';
const DAV_BASE_URL = 'https://dav.jianguoyun.com/dav';

/** 应用密码只留在内存里，不进响应式系统（避免被 devtools / 快照带出去） */
let appPassword = '';

export type ConnectOutcome =
  | { ok: true; createdRoot: boolean }
  | { ok: false; code: 'unauthorized' | 'forbidden' | 'unreachable' | 'other'; message: string };

/** 适配器给的错误码收敛成界面认识的四种，文案直接用适配器带出来的那条 */
function toOutcome(error: unknown): ConnectOutcome {
  if (error instanceof StorageError) {
    const code =
      error.code === 'unauthorized' || error.code === 'forbidden' || error.code === 'unreachable'
        ? error.code
        : 'other';
    return { ok: false, code, message: error.message || '连接失败，请稍后重试' };
  }
  return { ok: false, code: 'other', message: '连接失败，请稍后重试' };
}

export const useNutstoreStore = defineStore('nutstore', () => {
  const status = ref<'idle' | 'connecting' | 'connected'>('idle');
  const account = ref('');
  const root = ref(DEFAULT_ROOT);
  const bootstrapped = ref(false);

  const isConnected = computed(() => status.value === 'connected');

  function config(): StorageConfig {
    return {
      kind: 'jianguoyun',
      baseUrl: DAV_BASE_URL,
      account: account.value,
      password: appPassword,
      root: root.value,
    };
  }

  /** 应用启动时从本机凭据恢复连接态（凭据在连接时已校验过，这里不重复打请求） */
  async function restore(): Promise<void> {
    try {
      const raw = await secretStore.read(SECRET_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<{ account: string; appPassword: string; root: string }>;
        if (saved.account && saved.appPassword) {
          account.value = saved.account;
          appPassword = saved.appPassword;
          root.value = saved.root || DEFAULT_ROOT;
          const adapter = new JianguoYunAdapter();
          adapter.adopt(config());
          setStorage(adapter);
          status.value = 'connected';
        }
      }
    } catch {
      await secretStore.clear(SECRET_KEY);
      setStorage(null);
    } finally {
      bootstrapped.value = true;
    }
  }

  /**
   * 连接：先用凭据真实探一次，通过了才落盘并把适配器注册给上层。
   * 同步根不存在时顺手建出来 —— DoNote 只在这个目录里活动。
   */
  async function connect(nextAccount: string, nextPassword: string): Promise<ConnectOutcome> {
    status.value = 'connecting';
    account.value = nextAccount.trim();
    appPassword = nextPassword;
    root.value = DEFAULT_ROOT;

    const adapter = new JianguoYunAdapter();
    try {
      const result = await adapter.connect(config());
      setStorage(adapter);
      await secretStore.write(
        SECRET_KEY,
        JSON.stringify({ account: account.value, appPassword, root: root.value }),
      );
      status.value = 'connected';
      return { ok: true, createdRoot: result.createdRoot };
    } catch (error) {
      setStorage(null);
      appPassword = '';
      status.value = 'idle';
      return toOutcome(error);
    }
  }

  async function disconnect(): Promise<void> {
    await secretStore.clear(SECRET_KEY);
    setStorage(null);
    appPassword = '';
    account.value = '';
    root.value = DEFAULT_ROOT;
    status.value = 'idle';
  }

  return {
    status,
    account,
    root,
    bootstrapped,
    isConnected,
    restore,
    connect,
    disconnect,
  };
});
