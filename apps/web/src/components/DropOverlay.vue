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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useUiStore } from '@/stores/ui';
import { isTauriRuntime } from '@/storage/transport';
import { containerDirOf, decodeId } from '@/storage/notes';
import { importItems, itemsFromFiles, itemsFromPaths, type ImportItem, type ImportOptions } from '@/services/import-drop';
import { resolveDropPoint, setDropHover, type DropPoint } from '@/services/drop-target';

const ui = useUiStore();
const route = useRoute();
const dragging = ref(false);
const progress = ref('');
const busy = ref(false);
/** 这次拖放会落到哪个目录（落在侧栏行上才有值，null = 沿用当前页 / 根） */
const target = ref<DropPoint | null>(null);

/**
 * 正在看某篇笔记时，拖进来的 .md 变成它的**子页面**（Notion 的行为：拖到页面下 = 挂上去）。
 * 其它页面维持原样（各变成一篇同级笔记）。
 *
 * 落点由 `containerDirOf` 决定：页面 → 它自己的目录；普通笔记 → 它所在的目录。
 * `null` 表示「当前不是笔记详情页」，走老行为。
 */
const hostDir = computed<string | null>(() => {
  if (route.name !== 'note') return null;
  const id = String(route.params.id ?? '');
  if (!id) return null;
  try {
    return containerDirOf(decodeId(id));
  } catch {
    return null; // id 不是合法 base64url（手改地址栏），当普通页面处理
  }
});

/**
 * 拖进来的 .md 落在哪儿。
 *
 * 落在侧栏某一行上 → 那一行代表的目录（文件夹行 = 它自己，笔记行 = 它所在的目录）；
 * 没落在行上 → 沿用老行为：正在看某篇笔记时拖进来的变成它的**子页面**，否则各是一篇同级笔记。
 */
async function run(items: ImportItem[], point: DropPoint | null): Promise<void> {
  if (!items.length) {
    ui.toast('没有可导入的 .md 文件');
    return;
  }
  busy.value = true;
  progress.value = `导入中 0/${items.length}`;
  const options: ImportOptions = point
    ? { baseFolderId: point.folderId }
    : { asChildPagesOf: hostDir.value };
  try {
    const result = await importItems(items, {
      ...options,
      onProgress: (done, total) => {
        progress.value = `导入中 ${done}/${total}`;
      },
    });
    if (point) {
      ui.toast(
        `已导入 ${result.notes} 篇到${point.folderId ? `「${point.label}」` : '未归类'}`,
        3200,
      );
    } else {
      ui.toast(
        hostDir.value !== null
          ? `已导入 ${result.notes} 个子页面`
          : `已导入 ${result.notes} 篇笔记${result.folders ? `、${result.folders} 个文件夹` : ''}`,
        3200,
      );
    }
  } catch (err) {
    ui.toast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', 3600);
  } finally {
    busy.value = false;
    progress.value = '';
  }
}

/** 指针压在侧栏哪一行上（决定导入落到哪个目录），同时把高亮画出来 */
function hoverAt(x: number, y: number): DropPoint | null {
  const point = resolveDropPoint(x, y);
  target.value = point;
  setDropHover(point?.key ?? null);
  return point;
}

/** 松手 / 拖出窗口时清干净，别把高亮留在侧栏上 */
function clearHover(): void {
  target.value = null;
  setDropHover(null);
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
  hoverAt(event.clientX, event.clientY);
}

function onDragLeave(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0) {
    dragging.value = false;
    clearHover();
  }
}

function onDrop(event: DragEvent): void {
  depth = 0;
  dragging.value = false;
  if (busy.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  const point = resolveDropPoint(event.clientX, event.clientY);
  clearHover();
  void run(itemsFromFiles(files), point);
}

/* --------------------------- 桌面端：Tauri 拖放 --------------------------- */

let stopTauri: (() => void) | null = null;

/** Tauri 给的是物理像素的窗口坐标，elementFromPoint 要的是 CSS 像素 */
function toClientPosition(position: unknown): { x: number; y: number } | null {
  if (!position || typeof position !== 'object') return null;
  const raw = position as {
    x?: number;
    y?: number;
    toLogical?: (scale: number) => { x: number; y: number };
  };
  if (typeof raw.toLogical === 'function') {
    const logical = raw.toLogical(window.devicePixelRatio || 1);
    return { x: logical.x, y: logical.y };
  }
  return typeof raw.x === 'number' && typeof raw.y === 'number' ? { x: raw.x, y: raw.y } : null;
}

async function listenTauri(): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  stopTauri = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === 'over' || payload.type === 'enter') {
      dragging.value = true;
      // 压在侧栏某一行上时那一行亮起来 —— 松手就落到那儿，不再由「当前页面」决定
      const at = toClientPosition(payload.position);
      if (at) hoverAt(at.x, at.y);
      else clearHover();
      return;
    }
    if (payload.type === 'leave') {
      dragging.value = false;
      clearHover();
      return;
    }
    dragging.value = false;
    if (busy.value) return;
    const at = toClientPosition(payload.position);
    const point = at ? resolveDropPoint(at.x, at.y) : null;
    clearHover();
    void itemsFromPaths(payload.paths).then((items) => run(items, point));
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
        <p class="drop-tip">
          {{
            target
              ? `放进${target.folderId ? `「${target.label}」` : '未归类'}`
              : hostDir !== null
                ? '.md 会变成这篇笔记的子页面'
                : '拖到左侧某个文件夹上可以指定位置；不然各是一篇笔记'
          }}
        </p>
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
