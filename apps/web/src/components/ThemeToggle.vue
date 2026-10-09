<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';

const theme = useThemeStore();
const label = computed(() => (theme.theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'));
</script>

<template>
  <button class="toggle glass" :aria-label="label" :title="label" @click="theme.toggle()">
    <svg v-if="theme.theme === 'dark'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </svg>
  </button>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--r-pill);
  color: var(--text-2);
  transition:
    color var(--dur) var(--ease-smooth),
    transform var(--dur) var(--ease-spring);
}

.toggle:hover {
  color: var(--text);
}

.toggle:active {
  transform: scale(0.94);
}
</style>
