<script setup lang="ts">
/**
 * 批量操作工具栏。底部悬浮毛玻璃，只在多选态出现。
 *
 * 一个组件管完「选完之后的全部事」：确认框、进度、汇总、重试。
 * 各视图只负责把「选中的 id / 全集 / 标签 / 可移动到的位置」传进来，
 * 以及被通知 `done` 时重新拉一次列表。
 *
 * 层级：`.rail` 20 < 本工具栏 21 < AppDialog 22 < `.toast` 30。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { FolderDTO } from '@donote/shared';
import { foldersApi, notesApi } from '@/storage/notes';
import { batchExecute, summarize } from '@/services/batch';
import { useSelectionStore, type SelectionContext } from '@/stores/selection';
import { useUiStore } from '@/stores/ui';
import type { FolderRow } from '@/utils/folder-tree';
import AppDialog from '@/components/AppDialog.vue';

const props = defineProps<{
  context: SelectionContext;
  /** 当前选中的、且仍然存在于本列表的 id */
  ids: string[];
  /** 用来「全选」的全集 */
  allIds: string[];
  /** 把 id 变成人看得懂的名字，用在汇总里 */
  labelOf: (id: string) => string;
  /** 可移动到的位置；`context === 'folders'` 时父视图已按选中项排掉了自己与子树 */
  targets?: FolderRow[];
}>();

const emit = defineEmits<{ done: [] }>();

const sel = useSelectionStore();
const ui = useUiStore();

const busy = ref(false);
const progress = ref<{ done: number; total: number; verb: string } | null>(null);
/** 上一次跑完还留着没做成的项 —— 它们仍在选中态里，可以直接再点一次 */
const retryable = ref(false);
/** 第一条失败的原因 + 是谁，写在工具栏上方那条提示里（toast 一行放不下） */
const hintReason = ref('');
const confirm = ref<'' | 'remove' | 'purge'>('');
const moveOpen = ref(false);

interface PickRow {
  folder: FolderDTO | null;
  depth: number;
}
const pickRows = computed<PickRow[]>(() => [{ folder: null, depth: 0 }, ...(props.targets ?? [])]);

const deleteLabel = computed(() =>
  props.context === 'trash' ? '彻底删除' : props.context === 'folders' ? '解散' : '删除',
);

const confirmTitle = computed(() => {
  if (confirm.value === 'purge') return '彻底删除？';
  return props.context === 'folders' ? '解散这些文件夹？' : '删除这些笔记？';
});

const confirmText = computed(() => {
  const n = props.ids.length;
  if (confirm.value === 'purge') return `将从你的网盘里永久删除 ${n} 项，无法恢复。`;
  if (props.context === 'folders') {
    // 文件夹的「删除」其实是「解散」，不写清楚会被理解成连带删除
    return `将解散 ${n} 个文件夹：里面的笔记与子文件夹会移动到上一级，笔记不会被删除。`;
  }
  return `将把 ${n} 篇笔记移入回收站，之后可以恢复。`;
});

/* ------------------------------ 操作本体 ------------------------------ */

function removeOne(id: string): Promise<unknown> {
  return props.context === 'folders' ? foldersApi.remove(id) : notesApi.remove(id);
}

function moveOne(id: string, parentId: string | null): Promise<unknown> {
  return props.context === 'folders'
    ? foldersApi.move(id, parentId)
    : notesApi.update(id, { folder_id: parentId });
}

async function run(verb: string, operation: (id: string) => Promise<unknown>): Promise<void> {
  if (busy.value || !props.ids.length) return;
  const items = [...props.ids];
  busy.value = true;
  retryable.value = false;
  hintReason.value = '';
  progress.value = { done: 0, total: items.length, verb };
  try {
    const result = await batchExecute(items, operation, {
      onProgress: (done, total) => {
        progress.value = { done, total, verb };
      },
    });
    ui.toast(summarize(result, verb), 4200);
    const first = result.failed[0];
    if (first) hintReason.value = `${props.labelOf(first.id)}：${first.message}`;
    else if (result.aborted.length) hintReason.value = '网盘暂时不接受请求，过一会儿再试';
    // 做成的从选中里摘掉；失败的和没轮到的留着，用户能一眼看见还剩哪些，再点一次就是重试
    sel.selectAll([...result.failed.map((item) => item.id), ...result.aborted]);
    retryable.value = sel.count > 0;
    if (!sel.count) sel.exitSelecting();
    emit('done');
  } finally {
    busy.value = false;
    progress.value = null;
  }
}

function askRemove(): void {
  confirm.value = props.context === 'trash' ? 'purge' : 'remove';
}

function restoreAll(): void {
  void run('恢复', (id) => notesApi.restore(id));
}

function submitConfirm(): void {
  const kind = confirm.value;
  confirm.value = '';
  if (kind === 'purge') void run('彻底删除', (id) => notesApi.remove(id, true));
  else void run(props.context === 'folders' ? '解散' : '删除', removeOne);
}

function submitMove(parentId: string | null): void {
  moveOpen.value = false;
  void run('移动', (id) => moveOne(id, parentId));
}

/* ------------------------------ 键盘 ------------------------------ */

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // 对话框自己处理 Esc，别把它和「退出多选」叠在一起
    if (confirm.value || moveOpen.value) return;
    sel.exitSelecting();
    return;
  }
  const el = document.activeElement as HTMLElement | null;
  const typing =
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (typing || busy.value) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    sel.selectAll(props.allIds);
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    askRemove();
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  // 本组件只在多选态存在：它消失（切页 / 退出多选）就意味着多选态该收回了
  sel.exitSelecting();
});
</script>

<template>
  <Teleport to="body">
    <div class="bar glass" role="toolbar" aria-label="批量操作">
      <span class="count">
        {{ progress ? `正在${progress.verb} ${progress.done}/${progress.total}` : `已选 ${sel.count} 项` }}
      </span>

      <div class="ops">
        <button v-if="context !== 'trash'" type="button" class="op" :disabled="busy" @click="moveOpen = true">
          移动到…
        </button>
        <button v-else type="button" class="op" :disabled="busy" @click="restoreAll">
          恢复
        </button>
        <button
          type="button"
          class="op"
          :class="{ 'is-danger': context === 'trash' }"
          :disabled="busy"
          @click="askRemove"
        >
          {{ deleteLabel }}
        </button>
      </div>

      <button type="button" class="ghost" :disabled="busy" @click="sel.selectAll(allIds)">全选</button>
      <button type="button" class="ghost" :disabled="busy" @click="sel.exitSelecting()">取消</button>
    </div>

    <p v-if="retryable && !progress" class="retry-hint glass">
      未完成的 {{ sel.count }} 项仍在选中，可直接再点一次重试{{ hintReason ? `（${hintReason}）` : '' }}
    </p>

    <AppDialog
      :open="!!confirm"
      :title="confirmTitle"
      :confirm-label="deleteLabel"
      danger
      :busy="busy"
      @close="confirm = ''"
      @confirm="submitConfirm"
    >
      <p class="tip">{{ confirmText }}</p>
    </AppDialog>

    <AppDialog
      :open="moveOpen"
      title="移动到"
      confirm-label="关闭"
      :busy="busy"
      @close="moveOpen = false"
      @confirm="moveOpen = false"
    >
      <p class="tip">把选中的 {{ ids.length }} 项放到：</p>
      <div class="folder-list pick-gap">
        <button
          v-for="row in pickRows"
          :key="row.folder ? row.folder.id : '__root__'"
          type="button"
          class="folder-pick"
          :data-id="row.folder ? row.folder.id : '__root__'"
          :disabled="busy"
          :style="{ paddingLeft: `calc(var(--sp-2) + ${row.depth * 18}px)` }"
          @click="submitMove(row.folder ? row.folder.id : null)"
        >
          <template v-if="row.folder">📁 {{ row.folder.name }}</template>
          <template v-else>根目录</template>
        </button>
      </div>
    </AppDialog>
  </Teleport>
</template>

<style scoped>
.bar {
  position: fixed;
  bottom: calc(84px + env(safe-area-inset-bottom, 0px));
  /* 21 = 在侧栏（.rail 20）之上、AppDialog（22）之下 */
  z-index: 21;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 10px var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--glass-bg);
  box-shadow: var(--shadow-2);
}

/*
 * 两个 fixed 浮条都居中于**内容区**，不是视口。
 *
 * --content-offset 就是桌面端侧栏让出的宽度（收起 / 移动端为 0）。
 * 按视口居中的话，窄桌面窗口（< ~1180px）浮条会左移到侧栏上；
 * 而它们的 z-index 是 21、比侧栏的 20 高 —— 会直接把侧栏盖住。
 */
.bar,
.retry-hint {
  left: calc(var(--content-offset) + (100% - var(--content-offset)) / 2);
  transform: translateX(-50%);
  width: min(calc(100% - var(--content-offset) - 2 * var(--sp-3)), 660px);
}

@media (min-width: 1024px) {
  .bar {
    bottom: var(--sp-4);
  }
}

.count {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ops {
  display: flex;
  gap: 4px;
}

.op,
.ghost {
  height: 36px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.op {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text);
}

.op.is-danger {
  color: var(--danger);
}

.op:hover:not(:disabled),
.ghost:hover:not(:disabled) {
  background: var(--accent-soft);
}

.ghost {
  color: var(--text-2);
}

.op:disabled,
.ghost:disabled {
  opacity: 0.5;
}

.retry-hint {
  position: fixed;
  /* 压在工具栏上方，别互相盖住 */
  bottom: calc(136px + env(safe-area-inset-bottom, 0px));
  z-index: 21;
  padding: 8px var(--sp-2);
  border-radius: var(--r-md);
  background: var(--glass-bg);
  font-size: 12px;
  color: var(--text-2);
  text-align: center;
}

.tip {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}

.pick-gap {
  margin-top: var(--sp-1);
}
</style>
