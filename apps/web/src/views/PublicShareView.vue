<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { PublicShareDTO } from '@donote/shared';
import { publicApi } from '@/api/resources';
import { ApiError } from '@/api/client';
import { formatTime } from '@/utils/format';
import MarkdownView from '@/components/MarkdownView.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

type State = 'loading' | 'ok' | 'password' | 'gone' | 'missing' | 'error';

const route = useRoute();
const slug = String(route.params.slug);

const state = ref<State>('loading');
const share = ref<PublicShareDTO | null>(null);
const password = ref('');
const passwordError = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  try {
    share.value = await publicApi.share(slug);
    state.value = 'ok';
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'password_required') state.value = 'password';
      else if (err.code === 'gone') state.value = 'gone';
      else if (err.code === 'not_found') state.value = 'missing';
      else state.value = 'error';
      return;
    }
    state.value = 'error';
  }
}

async function submit(): Promise<void> {
  if (busy.value) return;
  passwordError.value = '';
  busy.value = true;
  try {
    share.value = await publicApi.shareWithPassword(slug, password.value);
    state.value = 'ok';
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === 'unauthorized') {
        passwordError.value = '密码不正确，请重试';
      } else if (err.code === 'gone') {
        state.value = 'gone';
      } else if (err.code === 'not_found') {
        state.value = 'missing';
      } else {
        passwordError.value = err.message;
      }
    } else {
      passwordError.value = '网络异常，请稍后重试';
    }
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="share">
    <header class="bar">
      <RouterLink class="brand" to="/">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              d="M6 3.75h9.5a2.75 2.75 0 0 1 2.75 2.75v13.75H8.75A2.75 2.75 0 0 1 6 17.5V3.75Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="brand-name">DoNote</span>
      </RouterLink>
      <ThemeToggle />
    </header>

    <main class="sheet">
      <div v-if="state === 'loading'" class="state-card glass pop">
        <p class="state-title">正在打开…</p>
      </div>

      <div v-else-if="state === 'ok' && share" class="doc pop">
        <h1 class="doc-title">{{ share.title }}</h1>
        <p class="doc-meta">更新于 {{ formatTime(share.updated_at) }}</p>
        <MarkdownView :source="share.content" empty="这篇笔记还没有内容" />
      </div>

      <div v-else-if="state === 'password'" class="state-card glass pop">
        <h2 class="state-title">需要密码</h2>
        <p class="state-hint">这篇笔记的分享链接受密码保护</p>
        <form class="pwd" @submit.prevent="submit">
          <input
            v-model="password"
            class="pwd-input"
            type="password"
            placeholder="请输入访问密码"
            autocomplete="off"
            :disabled="busy"
          />
          <button class="btn-major" type="submit" :disabled="busy">
            {{ busy ? '验证中…' : '打开' }}
          </button>
        </form>
        <p v-if="passwordError" class="pwd-error">{{ passwordError }}</p>
      </div>

      <div v-else-if="state === 'gone'" class="state-card glass pop">
        <h2 class="state-title">内容已删除</h2>
        <p class="state-hint">这篇笔记已被作者删除，或分享链接已过期。</p>
      </div>

      <div v-else-if="state === 'missing'" class="state-card glass pop">
        <h2 class="state-title">链接无效</h2>
        <p class="state-hint">这个分享链接不存在，或已被作者撤销。</p>
      </div>

      <div v-else class="state-card glass pop">
        <h2 class="state-title">打不开</h2>
        <p class="state-hint">网络或服务异常，请稍后重试。</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.share {
  position: relative;
  z-index: 1;
  min-height: 100%;
  padding-bottom: var(--sp-5);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-1) var(--sp-2);
  padding-top: calc(var(--sp-1) + env(safe-area-inset-top, 0px));
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent);
}

.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.sheet {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-2);
}

.doc {
  padding: var(--sp-3) var(--sp-2);
  border-radius: var(--r-xl);
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  box-shadow: var(--shadow-card);
}

.doc-title {
  font-size: 26px;
  line-height: 1.3;
}

.doc-meta {
  margin: 6px 0 var(--sp-3);
  font-size: 12px;
  color: var(--text-2);
}

.state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-5) var(--sp-3);
  border-radius: var(--r-xl);
  text-align: center;
}

.state-title {
  font-size: 19px;
  font-weight: 620;
}

.state-hint {
  font-size: 14px;
  color: var(--text-2);
  max-width: 26em;
}

.pwd {
  display: flex;
  gap: var(--sp-1);
  width: 100%;
  max-width: 340px;
  margin-top: var(--sp-2);
}

.pwd-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 46px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-size: 15px;
}

.pwd-error {
  margin-top: var(--sp-1);
  font-size: 13px;
  color: var(--danger);
}

.pop {
  animation: pop-in var(--dur-slow) var(--ease-spring) both;
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
