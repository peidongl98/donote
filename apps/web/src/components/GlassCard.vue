<script setup lang="ts">
/** 毛玻璃容器：登录卡片 / 弹窗 / 抽屉统一用它，保证只有一处 backdrop-filter */
withDefaults(defineProps<{ lift?: boolean }>(), { lift: false });
</script>

<template>
  <section class="glass card" :class="{ lift }">
    <slot />
  </section>
</template>

<style scoped>
.card {
  padding: var(--sp-4);
  border-radius: var(--r-xl);
}

@media (max-width: 480px) {
  .card {
    padding: var(--sp-3);
  }
}
</style>
