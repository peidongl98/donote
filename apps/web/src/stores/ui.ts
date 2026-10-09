import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 极简全局提示：同一时刻只显示一条，新消息直接顶掉旧的 */
export const useUiStore = defineStore('ui', () => {
  const message = ref('');
  let timer: ReturnType<typeof setTimeout> | null = null;

  function toast(text: string, duration = 2200): void {
    message.value = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      message.value = '';
      timer = null;
    }, duration);
  }

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    message.value = '';
  }

  return { message, toast, clear };
});
