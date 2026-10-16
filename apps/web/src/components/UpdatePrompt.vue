<script setup lang="ts">
/**
 * 启动自检发现新版本 → 立刻弹一句问。
 *
 * 为什么不是 toast（0.4.3 改）：旧流程是「后台把整包下完 → 弹一条 2.2 秒的 toast，
 * 内容是『到设置里点重启以更新』」—— 下载要好几分钟、提示转瞬即逝，还要用户自己跑去设置页，
 * 结果谁也没看见过。按 `docs/ui-patterns.md` 的三档判据，「需要用户决定」就该用 AppDialog。
 *
 * 两次点击的分工：这里只负责「问」与「就地装」；下载仍然只在用户点了「立即更新」之后才开始，
 * 所以启动时不会偷偷占带宽，也不会打断正在写的笔记。
 */
import { computed, onMounted, ref } from 'vue';
import AppDialog from '@/components/AppDialog.vue';
import { useUiStore } from '@/stores/ui';
import { applyUpdate, autoState, ensureUpdateReady, startAutoUpdate } from '@/updater';

const ui = useUiStore();

const open = ref(false);
const version = ref('');
const notes = ref('');
const busy = ref(false);

const downloading = computed(() => autoState.value.kind === 'downloading');
const percent = computed(() => (autoState.value.kind === 'downloading' ? autoState.value.percent : 0));

onMounted(() => {
  startAutoUpdate((found) => {
    version.value = found.version;
    notes.value = found.notes;
    open.value = true;
  });
});

/** 点了「立即更新」才开始下载；下好了交给安装器重启，用户不用再管 */
async function install(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await ensureUpdateReady();
    await applyUpdate();
  } catch (error) {
    open.value = false;
    ui.toast(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    :title="`有新版本 ${version}`"
    confirm-label="立即更新并重启"
    cancel-label="稍后"
    :busy="busy"
    @close="open = false"
    @confirm="install"
  >
    <p class="lead">
      {{ downloading ? `正在下载 ${percent}%…` : '点「立即更新」会自动下载并重启一次，笔记不受影响。' }}
    </p>
    <!-- 更新说明：控制包有时写得很长，限高并留出滚动，别把对话框顶出屏幕 -->
    <p v-if="notes" class="notes">{{ notes }}</p>
  </AppDialog>
</template>

<style scoped>
.lead {
  font-size: 14px;
  color: var(--text-2);
}

.notes {
  margin-top: var(--sp-2);
  max-height: 38vh;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  /* 更新说明里作者敲的换行要保留，别挤成一坨 */
  white-space: pre-line;
}
</style>
