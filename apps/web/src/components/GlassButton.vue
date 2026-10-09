<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    loading?: boolean;
    disabled?: boolean;
    variant?: 'primary' | 'ghost';
    /** 表单内的提交按钮传 submit，普通按钮保持默认，避免误触发或双重提交 */
    type?: 'button' | 'submit';
  }>(),
  { loading: false, disabled: false, variant: 'primary', type: 'button' },
);

const emit = defineEmits<{ click: [] }>();
const isDisabled = computed(() => props.disabled || props.loading);
</script>

<template>
  <button
    class="btn"
    :type="type"
    :class="`is-${variant}`"
    :disabled="isDisabled"
    :aria-busy="loading"
    @click="emit('click')"
  >
    <span class="btn-label">{{ loading ? '' : label }}</span>
    <span v-if="loading" class="shimmer" aria-hidden="true" />
    <span class="sr-only">{{ loading ? `${label}中` : label }}</span>
  </button>
</template>

<style scoped>
.btn {
  position: relative;
  width: 100%;
  height: 52px;
  border-radius: var(--r-md);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: hidden;
  transition:
    transform var(--dur-fast) var(--ease-spring),
    box-shadow var(--dur) var(--ease-smooth),
    background-color var(--dur) var(--ease-smooth),
    opacity var(--dur) var(--ease-smooth);
}

.btn-label {
  position: relative;
  z-index: 1;
}

.is-primary {
  color: var(--on-accent);
  /* 极淡径向渐变，不用纯色块、不用 Material 浮起阴影 */
  background:
    radial-gradient(120% 160% at 20% 0%, rgba(255, 255, 255, 0.28), transparent 60%),
    var(--accent);
  box-shadow: 0 6px 18px rgba(91, 168, 140, 0.22);
}

.is-primary:hover:not(:disabled) {
  box-shadow: 0 8px 22px rgba(91, 168, 140, 0.3);
}

.is-ghost {
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--surface-border);
}

/* 按下缩放 0.96 */
.btn:active:not(:disabled) {
  transform: scale(0.96);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 加载用 shimmer，不用转圈 */
.shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.35) 50%,
    transparent 100%
  );
  animation: shimmer 1.2s linear infinite;
  will-change: transform;
}

@keyframes shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}

html[data-lite='1'] .shimmer {
  animation-duration: 2.4s;
}
</style>
