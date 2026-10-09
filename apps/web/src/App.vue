<script setup lang="ts">
import { RouterView } from 'vue-router';
</script>

<template>
  <RouterView v-slot="{ Component }">
    <Transition name="page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>
</template>

<style>
/* 页面转场：淡入 + 轻微上浮 */
.page-enter-active,
.page-leave-active {
  transition:
    opacity var(--dur) var(--ease-smooth),
    transform var(--dur) var(--ease-smooth);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
