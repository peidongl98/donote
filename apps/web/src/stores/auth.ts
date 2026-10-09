import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { AUTH_ROUTES, type TenantDTO, type UserDTO } from '@donote/shared';
import { apiRequest, setAuthToken, ApiError } from '@/api/client';

const TOKEN_KEY = 'donote.token';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null);
  const user = ref<UserDTO | null>(null);
  const tenant = ref<TenantDTO | null>(null);
  const bootstrapped = ref(false);

  const isLoggedIn = computed(() => Boolean(token.value));

  function persist(next: string | null): void {
    token.value = next;
    setAuthToken(next);
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  }

  /** 应用启动时用本地 token 静默换回用户信息 */
  async function restore(): Promise<void> {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      bootstrapped.value = true;
      return;
    }
    setAuthToken(stored);
    try {
      const res = await apiRequest<{ user: UserDTO; tenant: TenantDTO }>(AUTH_ROUTES.me);
      token.value = stored;
      user.value = res.user;
      tenant.value = res.tenant;
    } catch (err) {
      // 401/过期 → 清理；网络故障则保留 token，让守卫按未登录处理但不误删
      if (err instanceof ApiError && err.status === 401) persist(null);
    } finally {
      bootstrapped.value = true;
    }
  }

  /** 返回 devCode（仅 dev 环境后端会带，production 恒为 undefined） */
  async function sendCode(phone: string): Promise<string | undefined> {
    const res = await apiRequest<{ devCode?: string }>(AUTH_ROUTES.sendCode, {
      method: 'POST',
      body: { phone },
      anonymous: true,
    });
    return res.devCode;
  }

  async function verify(phone: string, code: string): Promise<void> {
    const res = await apiRequest<{ token: string; user: UserDTO; tenant: TenantDTO }>(
      AUTH_ROUTES.verify,
      { method: 'POST', body: { phone, code }, anonymous: true },
    );
    persist(res.token);
    user.value = res.user;
    tenant.value = res.tenant;
  }

  async function logout(): Promise<void> {
    try {
      await apiRequest(AUTH_ROUTES.logout, { method: 'POST' });
    } catch {
      // 服务端删除失败不阻塞本地登出
    }
    persist(null);
    user.value = null;
    tenant.value = null;
  }

  return { token, user, tenant, bootstrapped, isLoggedIn, restore, sendCode, verify, logout };
});
