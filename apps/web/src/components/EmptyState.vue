<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    hint?: string;
    /**
     * 加载中显示在骨架下面的一句说明。
     * 只在等得久的页面用（回收站：网盘限速，条目多时要排队）：没有它，
     * 三条白杠看起来就是卡死了。空态那一栏仍用 `hint`，两者互斥。
     */
    loadingHint?: string;
    /** 列表加载中：显示骨架而不是空态文案 */
    loading?: boolean;
  }>(),
  { hint: '', loadingHint: '', loading: false },
);
</script>

<template>
  <div v-if="loading" class="skeleton">
    <div v-for="i in 3" :key="i" class="row glass" />
    <p v-if="loadingHint" class="loading-hint">{{ loadingHint }}</p>
  </div>

  <div v-else class="empty">
    <span class="mark" aria-hidden="true">
      <slot name="icon" />
    </span>
    <p class="title">{{ title }}</p>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <div class="action"><slot /></div>
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.row {
  height: 76px;
  border-radius: var(--r-lg);
  position: relative;
  overflow: hidden;
}

.loading-hint {
  margin-top: calc(var(--sp-1) / 2);
  font-size: var(--fs-xs);
  color: var(--text-2);
  text-align: center;
}

/* 骨架用推移的柔光代替转圈 */
.row::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent, var(--glass-border), transparent);
  transform: translateX(-100%);
  animation: shimmer 1.5s var(--ease-smooth) infinite;
}

@keyframes shimmer {
  to {
    transform: translateX(100%);
  }
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-5) var(--sp-2);
  text-align: center;
}

.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: var(--sp-1);
  border-radius: var(--r-lg);
  background: var(--accent-soft);
  color: var(--accent);
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.hint {
  font-size: 13px;
  color: var(--text-2);
  max-width: 26em;
}

.action:not(:empty) {
  margin-top: var(--sp-2);
}
</style>
