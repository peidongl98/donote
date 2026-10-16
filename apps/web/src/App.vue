<script setup lang="ts">
import { computed, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import AppSidebar from '@/components/AppSidebar.vue';
import DropOverlay from '@/components/DropOverlay.vue';
import UpdatePrompt from '@/components/UpdatePrompt.vue';
import { runTrashAutoClean } from '@/services/trash-auto';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const ui = useUiStore();

/** 登录页没有导航；其余已连接页面都挂侧边栏 */
const showShell = computed(() => route.meta.requiresAuth === true);

/**
 * 回收站自动清理的**启动检查**：侧栏一出现（也就是连上之后）跑一次。
 * 用 watch 而不是 onMounted：启动瞬间还没连上，showShell 是 false；
 * 连上之后它才翻成 true，那一刻才是真正的「应用启动」。
 * 另一个触发点在 TrashView（打开回收站时），两边共用一个 60 秒节流。
 */
watch(
  () => showShell.value,
  (on) => {
    if (on) void runTrashAutoClean();
  },
  { immediate: true },
);
</script>

<template>
  <AppSidebar v-if="showShell" />

  <RouterView v-slot="{ Component }">
    <Transition name="page" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>

  <!-- 拖放导入：连上以后整窗都是投放区 -->
  <DropOverlay v-if="showShell" />

  <!-- 启动自检：发现新版本就弹一句（连不连服务器都要提，更新的是应用本体） -->
  <UpdatePrompt />

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
