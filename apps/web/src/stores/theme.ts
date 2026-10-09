import { defineStore } from 'pinia';
import { ref } from 'vue';

const THEME_KEY = 'donote.theme';
type Theme = 'dark' | 'light';

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<Theme>('dark');

  function apply(next: Theme): void {
    theme.value = next;
    document.documentElement.setAttribute('data-theme', next);
  }

  /** 与 index.html 内联脚本保持同一判断口径，避免二次跳变 */
  function init(): void {
    const stored = localStorage.getItem(THEME_KEY);
    const initial: Theme =
      stored === 'dark' || stored === 'light'
        ? stored
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    apply(initial);

    // 没有手动覆盖时，跟随系统变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (localStorage.getItem(THEME_KEY)) return;
      apply(e.matches ? 'dark' : 'light');
    });
  }

  function set(next: Theme): void {
    localStorage.setItem(THEME_KEY, next);
    apply(next);
  }

  function toggle(): void {
    set(theme.value === 'dark' ? 'light' : 'dark');
  }

  return { theme, init, set, toggle };
});
