<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DEFAULT_BASE_URL } from '@/services/storage';
import { useWebdavStore } from '@/stores/webdav';
import { useUiStore } from '@/stores/ui';
import GlassCard from '@/components/GlassCard.vue';
import GlassTextField from '@/components/GlassTextField.vue';
import GlassButton from '@/components/GlassButton.vue';
import WebdavGuide from '@/components/WebdavGuide.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const webdav = useWebdavStore();
const ui = useUiStore();
const router = useRouter();
const route = useRoute();

const serverUrl = ref(DEFAULT_BASE_URL);
const account = ref('');
const password = ref('');
const serverError = ref('');
const accountError = ref('');
const passwordError = ref('');
const banner = ref('');
const submitting = ref(false);

const isDev = import.meta.env.DEV;

/** 只接受 http/https 的绝对地址；返回去掉尾斜杠的结果，不合法返回 null */
function normalizeServer(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.host) return null;
  return value.replace(/\/+$/, '');
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  serverError.value = '';
  accountError.value = '';
  passwordError.value = '';
  banner.value = '';

  const server = normalizeServer(serverUrl.value);
  const a = account.value.trim();
  const p = password.value.trim();

  if (!server) {
    serverError.value = '请填 http:// 或 https:// 开头的地址';
    return;
  }
  if (!a) {
    accountError.value = '请填账号';
    return;
  }
  if (!p) {
    passwordError.value = '请填密码';
    return;
  }

  submitting.value = true;
  try {
    const res = await webdav.connect(server, a, p);
    if (!res.ok) {
      // 认证失败几乎总是密码填错了，落到密码框上比丢到通栏提示更好定位
      if (res.code === 'unauthorized') passwordError.value = res.message;
      else banner.value = res.message;
      return;
    }
    ui.toast(res.createdRoot ? `已连接，并建好了同步目录 ${webdav.root}` : '已连接');
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } finally {
    submitting.value = false;
  }
}

// 一旦重新输入就撤掉上一次的错误态，避免「已经改对了但红框还挂着」
watch(serverUrl, () => {
  if (serverError.value) serverError.value = '';
});
watch(account, () => {
  if (accountError.value) accountError.value = '';
});
watch(password, () => {
  if (passwordError.value) passwordError.value = '';
});
</script>

<template>
  <main class="login">
    <header class="topbar">
      <ThemeToggle />
    </header>

    <GlassCard class="panel lift">
      <div class="brand">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path
              d="M6 3.75h9.5a2.75 2.75 0 0 1 2.75 2.75v13.75H8.75A2.75 2.75 0 0 1 6 17.5V3.75Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path d="M9.5 8.5h5M9.5 12h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </span>
        <div>
          <h1 class="title">DoNote</h1>
          <p class="subtitle">连接你的 WebDAV，笔记存在自己的盘里</p>
        </div>
      </div>

      <form class="form" novalidate @submit.prevent="submit">
        <GlassTextField
          v-model="serverUrl"
          label="服务器地址"
          placeholder="https://dav.example.com/dav"
          autocomplete="off"
          :disabled="submitting"
          :error="serverError"
        />

        <GlassTextField
          v-model="account"
          label="账号"
          placeholder="你的账号"
          inputmode="email"
          autocomplete="username"
          :disabled="submitting"
          :error="accountError"
        />

        <GlassTextField
          v-model="password"
          label="密码"
          placeholder="应用密码"
          type="password"
          revealable
          autocomplete="current-password"
          :disabled="submitting"
          :error="passwordError"
        />

        <WebdavGuide :server="serverUrl" />

        <p v-if="banner" class="banner">{{ banner }}</p>

        <GlassButton label="连接" type="submit" :loading="submitting" />
      </form>

      <p class="footnote">
        地址、账号和密码只保存在这台设备上。<br />
        DoNote 不上传，服务器不存任何账号信息。
      </p>
      <p v-if="isDev" class="devnote">
        开发模式：凭据暂存在浏览器 localStorage，正式版会换成系统钥匙串
      </p>
    </GlassCard>

    <div class="glow" aria-hidden="true" />
  </main>
</template>

<style scoped>
.login {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 100%;
  padding: var(--sp-4) var(--sp-2);
  overflow: hidden;
}

.topbar {
  position: fixed;
  top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  right: var(--sp-2);
  z-index: 3;
}

/* 卡片从下方浮入 + 淡入 */
.panel {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 420px;
  animation: card-in var(--dur-slow) var(--ease-spring) both;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  color: var(--accent);
  background: var(--accent-soft);
  flex: none;
}

.title {
  font-size: 22px;
}

.subtitle {
  font-size: 13px;
  color: var(--text-2);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.banner {
  font-size: 13px;
  color: var(--danger);
}

.footnote {
  margin-top: var(--sp-3);
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}

.devnote {
  margin-top: var(--sp-1);
  text-align: center;
  font-size: 11px;
  color: var(--text-2);
  opacity: 0.7;
}

/* 背景光晕：只做一次轻微呼吸，不参与布局 */
.glow {
  position: absolute;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--bg-glow-1), transparent 70%);
  filter: blur(40px);
  z-index: 1;
  animation: breathe 12s ease-in-out infinite;
}

@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.9;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}

html[data-lite='1'] .glow {
  display: none;
}

@media (max-width: 480px) {
  .login {
    justify-content: flex-start;
    padding-top: var(--sp-6);
  }
}
</style>
