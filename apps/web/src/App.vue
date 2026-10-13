<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AppSidebar from '@/components/AppSidebar.vue';
import BottomTabs from '@/components/BottomTabs.vue';
import DropOverlay from '@/components/DropOverlay.vue';
import { useLayoutStore } from '@/stores/layout';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const ui = useUiStore();
const layout = useLayoutStore();

/** 底部导航只在主页面出现，编辑页、公开页保持全屏专注（桌面端由 CSS 隐藏，改用侧边栏） */
const showTabs = computed(() => route.meta.tabs === true);
/** 登录页没有导航；其余已连接页面都挂侧边栏 */
const showShell = computed(() => route.meta.requiresAuth === true);

onMounted(() => layout.init());
</script>

<template>
  <AppSidebar v-if="showShell" />

  <RouterView v-slot="{ Component }">
    <Transition name="page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>

  <BottomTabs v-if="showTabs" />

  <!-- 拖放导入：连上以后整窗都是投放区 -->
  <DropOverlay v-if="showShell" />

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
