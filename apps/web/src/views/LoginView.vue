<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PHONE_PATTERN, RATE_LIMITS } from '@donote/shared';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import GlassCard from '@/components/GlassCard.vue';
import GlassTextField from '@/components/GlassTextField.vue';
import GlassButton from '@/components/GlassButton.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const phone = ref('');
const code = ref('');
const devCode = ref('');
const phoneError = ref('');
const codeError = ref('');
const banner = ref('');

const sending = ref(false);
const submitting = ref(false);
const countdown = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

const canSend = computed(
  () => countdown.value === 0 && !sending.value && PHONE_PATTERN.test(phone.value.trim()),
);
const sendLabel = computed(() => (countdown.value > 0 ? `${countdown.value}s` : '获取验证码'));

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function startCountdown(): void {
  countdown.value = RATE_LIMITS.sendIntervalSec;
  stopTimer();
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) stopTimer();
  }, 1000);
}

async function sendCode(): Promise<void> {
  phoneError.value = '';
  banner.value = '';
  const value = phone.value.trim();
  if (!PHONE_PATTERN.test(value)) {
    phoneError.value = '请输入 11 位中国大陆手机号';
    return;
  }

  sending.value = true;
  try {
    const returned = await auth.sendCode(value);
    // devCode 仅开发构建展示：生产构建即使服务端误配也不会把它渲染出来
    devCode.value = import.meta.env.DEV ? (returned ?? '') : '';
    startCountdown();
  } catch (err) {
    banner.value = err instanceof ApiError ? err.message : '验证码发送失败';
    if (err instanceof ApiError && err.code === 'rate_limited') startCountdown();
  } finally {
    sending.value = false;
  }
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  phoneError.value = '';
  codeError.value = '';
  banner.value = '';
  const p = phone.value.trim();
  const c = code.value.trim();

  if (!PHONE_PATTERN.test(p)) {
    phoneError.value = '请输入 11 位中国大陆手机号';
    return;
  }
  if (!/^\d{6}$/.test(c)) {
    codeError.value = '请输入 6 位数字验证码';
    return;
  }

  submitting.value = true;
  try {
    await auth.verify(p, c);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(redirect);
  } catch (err) {
    codeError.value = err instanceof ApiError ? err.message : '登录失败，请重试';
  } finally {
    submitting.value = false;
  }
}

function fillDevCode(): void {
  code.value = devCode.value;
}

// 一旦重新输入就撤掉上一次的错误态，避免「已经改对了但红框还挂着」
watch(phone, () => {
  if (phoneError.value) phoneError.value = '';
});
watch(code, () => {
  if (codeError.value) codeError.value = '';
});

onBeforeUnmount(stopTimer);
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
          <p class="subtitle">用手机号登录或注册</p>
        </div>
      </div>

      <form class="form" novalidate @submit.prevent="submit">
        <GlassTextField
          v-model="phone"
          label="手机号"
          placeholder="请输入手机号"
          inputmode="tel"
          autocomplete="tel"
          :maxlength="11"
          :disabled="submitting"
          :error="phoneError"
        />

        <div class="code-row">
          <GlassTextField
            v-model="code"
            class="grow"
            label="验证码"
            placeholder="6 位数字"
            inputmode="numeric"
            autocomplete="one-time-code"
            :maxlength="6"
            :disabled="submitting"
            :error="codeError"
          />
          <button
            class="send mono"
            type="button"
            :disabled="!canSend"
            @click="sendCode"
          >
            {{ sendLabel }}
          </button>
        </div>

        <p v-if="banner" class="banner">{{ banner }}</p>

        <GlassButton label="登录 / 注册" type="submit" :loading="submitting" />
      </form>

      <p v-if="devCode" class="devcode mono">
        开发模式验证码：<strong>{{ devCode }}</strong>
        <button type="button" class="fill" @click="fillDevCode">填入</button>
      </p>

      <p class="footnote">未注册的手机号将自动创建账号</p>
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

.code-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-1);
}

.grow {
  flex: 1 1 auto;
  min-width: 0;
}

/* 与左侧输入框的控件顶边对齐：跳过标签所占的一行 */
.send {
  flex: none;
  margin-top: calc(var(--label-h) + var(--sp-1));
  height: 52px;
  min-width: 112px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  color: var(--accent);
  background: var(--accent-soft);
  font-size: 14px;
  font-weight: 600;
  transition:
    transform var(--dur-fast) var(--ease-spring),
    opacity var(--dur) var(--ease-smooth),
    background-color var(--dur) var(--ease-smooth);
}

.send:active:not(:disabled) {
  transform: scale(0.96);
}

.send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.banner {
  font-size: 13px;
  color: var(--danger);
}

.devcode {
  margin-top: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.devcode strong {
  color: var(--accent);
  letter-spacing: 0.1em;
}

.fill {
  margin-left: auto;
  font-size: 13px;
  color: var(--accent);
}

.footnote {
  margin-top: var(--sp-3);
  text-align: center;
  font-size: 12px;
  color: var(--text-2);
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
