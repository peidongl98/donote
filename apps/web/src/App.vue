<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import BottomTabs from '@/components/BottomTabs.vue';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const ui = useUiStore();

/** 底部导航只在主页面出现，编辑页、公开页保持全屏专注 */
const showTabs = computed(() => route.meta.tabs === true);
</script>

<template>
  <RouterView v-slot="{ Component }">
    <Transition name="page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>

  <BottomTabs v-if="showTabs" />

  <Transition name="toast">
    <div v-if="ui.message" class="toast glass">{{ ui.message }}</div>
  </Transition>
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
