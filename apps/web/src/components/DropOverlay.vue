<script setup lang="ts">
/**
 * 拖放导入的落点：整个窗口都是投放区。
 *
 * 两条事件源：
 * - 浏览器：HTML5 的 dragenter/dragover/drop（开发调试走这条）
 * - 桌面端：Tauri 的 onDragDropEvent。窗口开了 `dragDropEnabled`，系统的拖放会被
 *   Tauri 收走，页面里收不到 HTML5 的 drop，必须走这条（它给的是绝对路径）。
 *
 * 交互刻意做到最简：拖进来显示一层「松手导入」，松手后按「3/10」推进度，结束时 toast 汇总。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useUiStore } from '@/stores/ui';
import { isTauriRuntime } from '@/storage/transport';
import { importItems, itemsFromFiles, itemsFromPaths, type ImportItem } from '@/services/import-drop';

const ui = useUiStore();
const dragging = ref(false);
const progress = ref('');
const busy = ref(false);

async function run(items: ImportItem[]): Promise<void> {
  if (!items.length) {
    ui.toast('没有可导入的 .md 文件');
    return;
  }
  busy.value = true;
  progress.value = `导入中 0/${items.length}`;
  try {
    const result = await importItems(items, (done, total) => {
      progress.value = `导入中 ${done}/${total}`;
    });
    ui.toast(
      `已导入 ${result.notes} 篇笔记${result.folders ? `、${result.folders} 个文件夹` : ''}`,
      3200,
    );
  } catch (err) {
    ui.toast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', 3600);
  } finally {
    busy.value = false;
    progress.value = '';
  }
}

/* --------------------------- 浏览器：HTML5 拖放 --------------------------- */

let depth = 0;

function onDragEnter(event: DragEvent): void {
  if (busy.value || !event.dataTransfer?.types.includes('Files')) return;
  depth += 1;
  dragging.value = true;
}

function onDragOver(event: DragEvent): void {
  if (!dragging.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0) dragging.value = false;
}

function onDrop(event: DragEvent): void {
  depth = 0;
  dragging.value = false;
  if (busy.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  void run(itemsFromFiles(files));
}

/* --------------------------- 桌面端：Tauri 拖放 --------------------------- */

let stopTauri: (() => void) | null = null;

async function listenTauri(): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  stopTauri = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === 'over') {
      dragging.value = true;
      return;
    }
    if (payload.type === 'leave') {
      dragging.value = false;
      return;
    }
    if (payload.type === 'drop') {
      dragging.value = false;
      if (busy.value) return;
      // 只处理真正拖进来的文件（payload.position 是鼠标位置，这里不按落点分流）
      void itemsFromPaths(payload.paths).then(run);
    }
  });
}

onMounted(() => {
  if (isTauriRuntime()) {
    void listenTauri();
    return;
  }
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
});

onBeforeUnmount(() => {
  stopTauri?.();
  window.removeEventListener('dragenter', onDragEnter);
  window.removeEventListener('dragover', onDragOver);
  window.removeEventListener('dragleave', onDragLeave);
  window.removeEventListener('drop', onDrop);
});
</script>

<template>
  <Transition name="drop">
    <div v-if="dragging" class="drop-mask">
      <div class="drop-card">
        <p class="drop-title">松手导入</p>
        <p class="drop-tip">.md 会各变成一篇笔记，文件夹会跟着建出来</p>
      </div>
    </div>
  </Transition>

  <div v-if="progress" class="drop-progress glass">{{ progress }}</div>
</template>

<style scoped>
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: none;
}

.drop-card {
  padding: var(--sp-4) var(--sp-5);
  border-radius: var(--r-lg);
  text-align: center;
  background: var(--surface);
  border: 1px dashed var(--accent-ring);
  box-shadow: var(--shadow-3);
}

.drop-title {
  font-size: var(--fs-lg, 17px);
  font-weight: 640;
  color: var(--accent);
}

.drop-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.drop-progress {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 31;
  padding: 8px 14px;
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  color: var(--text);
  transform: translateX(-50%);
}

.drop-enter-active,
.drop-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.drop-enter-from,
.drop-leave-to {
  opacity: 0;
}
</style>
