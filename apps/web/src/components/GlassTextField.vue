<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    placeholder?: string;
    type?: string;
    inputmode?: 'text' | 'numeric' | 'tel';
    maxlength?: number;
    autocomplete?: string;
    disabled?: boolean;
    /** 非空即视为错误态：红框 + 抖动一次 */
    error?: string;
  }>(),
  { type: 'text', placeholder: '', inputmode: 'text', maxlength: undefined, autocomplete: 'off', disabled: false, error: '' },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const shaking = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

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
    <input
      ref="inputEl"
      class="input mono"
      :value="modelValue"
      :type="type"
      :inputmode="inputmode"
      :maxlength="maxlength"
      :autocomplete="autocomplete"
      :disabled="disabled"
      :placeholder="placeholder"
      @input="onInput"
      @animationend="shaking = false"
    />
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
