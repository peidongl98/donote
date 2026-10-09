<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    placeholder?: string;
    type?: string;
    inputmode?: 'text' | 'numeric' | 'tel' | 'email';
    maxlength?: number;
    autocomplete?: string;
    disabled?: boolean;
    /** 非空即视为错误态：红框 + 抖动一次 */
    error?: string;
    /** 密码类字段：右侧给一个明文/掩码切换按钮 */
    revealable?: boolean;
  }>(),
  {
    type: 'text',
    placeholder: '',
    inputmode: 'text',
    maxlength: undefined,
    autocomplete: 'off',
    disabled: false,
    error: '',
    revealable: false,
  },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const shaking = ref(false);
const revealed = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

// 只有 revealable 字段才会把 type 在 password / text 之间切
const inputType = computed(() => (props.revealable && revealed.value ? 'text' : props.type));

// 错误从无到有时重放抖动：先归位再下一帧开启，保证同一错误连续提交也能看到反馈
watch(
  () => props.error,
  (next) => {
    if (!next) return;
    shaking.value = false;
    requestAnimationFrame(() => {
      shaking.value = true;
    });
  },
);

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <label class="field" :class="{ 'is-error': !!error, 'is-shaking': shaking }">
    <span class="label">{{ label }}</span>
    <span class="control">
      <input
        ref="inputEl"
        class="input mono"
        :class="{ 'has-reveal': revealable }"
        :value="modelValue"
        :type="inputType"
        :inputmode="inputmode"
        :maxlength="maxlength"
        :autocomplete="autocomplete"
        :disabled="disabled"
        :placeholder="placeholder"
        @input="onInput"
        @animationend="shaking = false"
      />
      <button
        v-if="revealable"
        type="button"
        class="reveal"
        :aria-label="revealed ? '隐藏' : '显示'"
        :aria-pressed="revealed"
        tabindex="-1"
        @click.prevent="revealed = !revealed"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            v-if="!revealed"
            d="m4 20 16-16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </span>
    <Transition name="hint">
      <span v-if="error" class="hint">{{ error }}</span>
    </Transition>
  </label>
</template>

<style scoped>
.field {
  display: block;
  position: relative;
}

.control {
  display: block;
  position: relative;
}

.reveal {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-smooth);
}

.reveal:hover {
  color: var(--accent);
}

.input.has-reveal {
  padding-right: 50px;
}

.label {
  display: block;
  height: var(--label-h);
  line-height: var(--label-h);
  margin-bottom: var(--sp-1);
  font-size: 13px;
  color: var(--text-2);
  letter-spacing: 0.02em;
}

.input {
  width: 100%;
  height: 52px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text);
  font-size: 17px;
  letter-spacing: 0.06em;
  transition:
    border-color var(--dur-fast) var(--ease-smooth),
    box-shadow var(--dur-fast) var(--ease-smooth),
    transform var(--dur) var(--ease-spring),
    background-color var(--dur) var(--ease-smooth);
}

.input::placeholder {
  color: var(--text-2);
  opacity: 0.6;
  letter-spacing: normal;
}

/* 聚焦：边框发光 + 轻微放大 */
.input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
  transform: scale(1.01);
}

.input:disabled {
  opacity: 0.55;
}

.is-error .input {
  border-color: var(--danger);
  box-shadow: 0 0 0 4px var(--danger-soft);
}

.hint {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: var(--danger);
}

.is-shaking {
  animation: shake 420ms var(--ease-smooth);
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  18% {
    transform: translateX(-6px);
  }
  38% {
    transform: translateX(5px);
  }
  58% {
    transform: translateX(-4px);
  }
  78% {
    transform: translateX(2px);
  }
}

.hint-enter-active,
.hint-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    transform var(--dur-fast) var(--ease-smooth);
}

.hint-enter-from,
.hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
