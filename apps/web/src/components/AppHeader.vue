<script setup lang="ts">
import { useRouter } from 'vue-router';
import ThemeToggle from './ThemeToggle.vue';

withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    /** 显示返回箭头（进入二级页面时用） */
    back?: boolean;
    /** 明确指定返回目标，缺省则用浏览器历史 */
    backTo?: string;
  }>(),
  { subtitle: '', back: false, backTo: '' },
);

const router = useRouter();

function goBack(to: string): void {
  if (to) router.push(to);
  else if (window.history.length > 1) router.back();
  else router.push('/');
}
</script>

<template>
  <header class="head glass">
    <button v-if="back" class="back" type="button" aria-label="返回" @click="goBack(backTo)">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          d="M14.5 5.5 8 12l6.5 6.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div class="titles">
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>

    <div class="actions">
      <slot name="actions" />
      <ThemeToggle />
    </div>
  </header>
</template>

<style scoped>
.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  padding-top: calc(var(--sp-1) + env(safe-area-inset-top, 0px));
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
}

.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin-left: -6px;
  border-radius: var(--r-pill);
  color: var(--text);
  flex: none;
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.back:hover {
  background: var(--surface);
}

.titles {
  min-width: 0;
  flex: 1 1 auto;
}

.title {
  font-size: 17px;
  font-weight: 620;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subtitle {
  font-size: 12px;
  color: var(--text-2);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
}
</style>
