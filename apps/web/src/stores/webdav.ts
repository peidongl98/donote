import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { secretStore } from '@/storage/secret-store';
import {
  DEFAULT_BASE_URL,
  DEFAULT_ROOT,
  setStorage,
  StorageError,
  WebdavAdapter,
  type StorageConfig,
} from '@/services/storage';
import { CachedStorage } from '@/services/cache/cached-adapter';
import { cacheStore } from '@/services/cache/store';
import { useSyncStore } from './sync';

/**
 * 凭据在本机的存储键。
 * 值沿用历史名称：改掉会让已经连好的设备下次启动读不到凭据、需要重新输一次密码。
 */
const SECRET_KEY = 'donote.nutstore';

/** 密码只留在内存里，不进响应式系统（避免被 devtools / 快照带出去） */
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

/**
 * 把适配器交给上层，并在外面套一层本地缓存。
 * 之所以套在注册点而不是改适配器内部：换掉存储协议时缓存层不用跟着动。
 */
function register(adapter: WebdavAdapter, root: string): void {
  const cached = new CachedStorage(adapter, cacheStore(), root);
  setStorage(cached);
  useSyncStore().attach(cached);
}

export const useWebdavStore = defineStore('webdav', () => {
  const status = ref<'idle' | 'connecting' | 'connected'>('idle');
  const baseUrl = ref(DEFAULT_BASE_URL);
  const account = ref('');
  const root = ref(DEFAULT_ROOT);
  const bootstrapped = ref(false);

  const isConnected = computed(() => status.value === 'connected');

  function config(): StorageConfig {
    return {
      kind: 'webdav',
      baseUrl: baseUrl.value,
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
        const saved = JSON.parse(raw) as Partial<{
          baseUrl: string;
          account: string;
          appPassword: string;
          root: string;
        }>;
        if (saved.account && saved.appPassword) {
          // baseUrl 是后加的字段，早期存档没有它，缺省即坚果云
          baseUrl.value = saved.baseUrl || DEFAULT_BASE_URL;
          account.value = saved.account;
          appPassword = saved.appPassword;
          root.value = saved.root || DEFAULT_ROOT;
          const adapter = new WebdavAdapter();
          adapter.adopt(config());
          register(adapter, root.value);
          status.value = 'connected';
        }
      }
    } catch {
      await secretStore.clear(SECRET_KEY);
      setStorage(null);
      useSyncStore().detach();
    } finally {
      bootstrapped.value = true;
    }
  }

  /**
   * 连接：先用凭据真实探一次，通过了才落盘并把适配器注册给上层。
   * 同步根不存在时顺手建出来 —— DoNote 只在这个目录里活动。
   */
  async function connect(
    nextBaseUrl: string,
    nextAccount: string,
    nextPassword: string,
  ): Promise<ConnectOutcome> {
    status.value = 'connecting';
    baseUrl.value = nextBaseUrl.trim().replace(/\/+$/, '');
    account.value = nextAccount.trim();
    appPassword = nextPassword;
    root.value = DEFAULT_ROOT;

    const adapter = new WebdavAdapter();
    try {
      const result = await adapter.connect(config());
      register(adapter, root.value);
      await secretStore.write(
        SECRET_KEY,
        JSON.stringify({
          baseUrl: baseUrl.value,
          account: account.value,
          appPassword,
          root: root.value,
        }),
      );
      status.value = 'connected';
      return { ok: true, createdRoot: result.createdRoot };
    } catch (error) {
      setStorage(null);
      useSyncStore().detach();
      appPassword = '';
      status.value = 'idle';
      return toOutcome(error);
    }
  }

  async function disconnect(): Promise<void> {
    await secretStore.clear(SECRET_KEY);
    setStorage(null);
    useSyncStore().detach();
    appPassword = '';
    baseUrl.value = DEFAULT_BASE_URL;
    account.value = '';
    root.value = DEFAULT_ROOT;
    status.value = 'idle';
  }

  return {
    status,
    baseUrl,
    account,
    root,
    bootstrapped,
    isConnected,
    restore,
    connect,
    disconnect,
  };
});
