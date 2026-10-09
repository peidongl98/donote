import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  DEFAULT_ROOT,
  ensureRoot,
  probeConnection,
  type NutstoreCredentials,
  type ProbeResult,
} from '@/storage/webdav';
import { secretStore } from '@/storage/secret-store';

const SECRET_KEY = 'donote.nutstore';

/** 应用密码只留在内存里，不进响应式系统（避免被 devtools / 快照带出去） */
let appPassword = '';

export type ConnectOutcome =
  | { ok: true; createdRoot: boolean }
  | { ok: false; code: 'unauthorized' | 'forbidden' | 'unreachable' | 'other'; message: string };

const MESSAGES: Record<'unauthorized' | 'forbidden' | 'unreachable' | 'other', string> = {
  unauthorized: '账号或应用密码不对，请核对后重试',
  forbidden: '被坚果云拒绝。多半是开了微信二次验证 —— WebDAV 不支持它，请先在网页端关掉',
  unreachable: '连不上坚果云，请检查网络（网页版会被浏览器的跨域策略拦住，属预期）',
  other: '连接失败，请稍后重试',
};

export const useNutstoreStore = defineStore('nutstore', () => {
  const status = ref<'idle' | 'connecting' | 'connected'>('idle');
  const account = ref('');
  const root = ref(DEFAULT_ROOT);
  const bootstrapped = ref(false);

  const isConnected = computed(() => status.value === 'connected');

  function credentials(): NutstoreCredentials {
    return { account: account.value, appPassword };
  }

  /** 应用启动时从本机凭据恢复连接态（凭据在连接时已校验过，这里不重复打请求） */
  async function restore(): Promise<void> {
    try {
      const raw = await secretStore.read(SECRET_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<NutstoreCredentials & { root: string }>;
        if (saved.account && saved.appPassword) {
          account.value = saved.account;
          appPassword = saved.appPassword;
          root.value = saved.root || DEFAULT_ROOT;
          status.value = 'connected';
        }
      }
    } catch {
      await secretStore.clear(SECRET_KEY);
    } finally {
      bootstrapped.value = true;
    }
  }

  function describe(probe: ProbeResult): ConnectOutcome {
    if (probe.kind === 'ok') return { ok: true, createdRoot: false };
    if (probe.kind === 'error') {
      return { ok: false, code: 'other', message: `${MESSAGES.other}（HTTP ${probe.status}）` };
    }
    if (probe.kind === 'unreachable') {
      const reason = probe.reason ? `（${probe.reason.slice(0, 120)}）` : '';
      return { ok: false, code: 'unreachable', message: `${MESSAGES.unreachable}${reason}` };
    }
    return { ok: false, code: probe.kind, message: MESSAGES[probe.kind] };
  }

  /**
   * 连接：先用凭据真实探一次坚果云，通过了才落盘。
   * 同步根不存在时顺手建出来 —— DoNote 只在这个目录里活动。
   */
  async function connect(nextAccount: string, nextPassword: string): Promise<ConnectOutcome> {
    status.value = 'connecting';
    account.value = nextAccount.trim();
    appPassword = nextPassword;

    const probe = await probeConnection(credentials(), DEFAULT_ROOT);
    const described = describe(probe);

    if (!described.ok) {
      appPassword = '';
      status.value = 'idle';
      return described;
    }

    let createdRoot = false;
    if (probe.kind === 'ok' && !probe.rootExists) {
      createdRoot = await ensureRoot(credentials());
    }

    root.value = DEFAULT_ROOT;
    await secretStore.write(
      SECRET_KEY,
      JSON.stringify({ account: account.value, appPassword, root: root.value }),
    );
    status.value = 'connected';
    return { ok: true, createdRoot };
  }

  async function disconnect(): Promise<void> {
    await secretStore.clear(SECRET_KEY);
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
    credentials,
    restore,
    connect,
    disconnect,
  };
});
