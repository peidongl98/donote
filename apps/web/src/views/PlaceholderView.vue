<script setup lang="ts">
import { useRoute } from 'vue-router';
import GlassCard from '@/components/GlassCard.vue';

const route = useRoute();
</script>

<template>
  <main class="placeholder">
    <div class="wrap">
      <GlassCard class="panel">
        <h2 class="title">占位页面</h2>
        <p class="path mono">{{ route.fullPath }}</p>
        <p class="desc">该路由已注册，功能在后续批次实现。</p>
      </GlassCard>
    </div>
  </main>
</template>

<style scoped>
.placeholder {
  padding: var(--sp-4) 0;
}

.panel {
  max-width: 480px;
  margin: 0 auto;
  text-align: center;
}

.title {
  font-size: 18px;
}

.path {
  margin-top: var(--sp-1);
  font-size: 13px;
  color: var(--accent);
}

.desc {
  margin-top: var(--sp-2);
  font-size: 14px;
  color: var(--text-2);
}
</style>
