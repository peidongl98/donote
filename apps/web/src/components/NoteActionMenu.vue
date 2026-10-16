<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { NoteSummaryDTO } from '@donote/shared';
import { DavError, notesApi } from '@/storage/notes';
import { useEditingStore } from '@/stores/editing';
import { useUiStore } from '@/stores/ui';
import AppDialog from '@/components/AppDialog.vue';
import MoveDialog from '@/components/MoveDialog.vue';

/**
 * 笔记动作菜单：右键卡片或点卡片右上角「更多」都会开它。
 * 回收站里那套（恢复 / 彻底删除）由 `TrashView` 自己出 —— 那边是树，节点层级不一样，
 * 共用一个组件反而要塞 mode 开关和两种目标。
 *
 * 菜单本身的 z-index 压得比 AppDialog 低，这样点开重命名 / 移动时，
 * 对话框盖在菜单上面，不需要先把菜单关掉。
 */
const props = defineProps<{
  note: NoteSummaryDTO | null;
}>();

const emit = defineEmits<{ close: []; done: [] }>();

const ui = useUiStore();
const editing = useEditingStore();

const renameOpen = ref(false);
const renameName = ref('');
const moveOpen = ref(false);
const deleteOpen = ref(false);
const busy = ref(false);

/** 这篇正在编辑中（详情页开着它），重命名 / 移动 / 删除先禁掉 */
const locked = computed(() => Boolean(props.note) && editing.editingNoteId === props.note?.id);

watch(
  () => props.note,
  (next) => {
    if (next) renameName.value = next.title;
  },
);

/** 收尾：提示 + 让父级刷新 + 关掉菜单 */
function finish(message: string): void {
  ui.toast(message);
  emit('done');
  emit('close');
}

async function submitRename(): Promise<void> {
  const note = props.note;
  const name = renameName.value.trim();
  if (!note) return;
  if (!name || name === note.title) {
    renameOpen.value = false;
    return;
  }
  busy.value = true;
  try {
    await notesApi.update(note.id, { title: name });
    renameOpen.value = false;
    finish('已重命名');
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '重命名失败');
  } finally {
    busy.value = false;
  }
}

function openMove(): void {
  moveOpen.value = true;
}

async function moveTo(folderId: string | null): Promise<void> {
  const note = props.note;
  if (!note) return;
  busy.value = true;
  try {
    await notesApi.update(note.id, { folder_id: folderId });
    moveOpen.value = false;
    finish(folderId ? '已移动' : '已移到未归类');
  } catch {
    ui.toast('移动失败');
  } finally {
    busy.value = false;
  }
}

async function softDelete(): Promise<void> {
  const note = props.note;
  if (!note) return;
  busy.value = true;
  try {
    await notesApi.remove(note.id);
    deleteOpen.value = false;
    finish('已移入回收站');
  } catch (err) {
    // 带上原因：撞限流（503）与「代码坏了」对用户是两件事，只说「删除失败」等于没说
    ui.toast(err instanceof DavError ? err.message : '删除失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="note" class="sheet-mask" @click.self="emit('close')">
        <div class="sheet glass">
          <p class="sheet-title">{{ note.title }}</p>

          <p v-if="locked" class="sheet-lock">这篇笔记正在编辑中，先离开编辑页再来操作</p>

          <button
            type="button"
            class="sheet-item"
            :disabled="locked || busy"
            @click="renameOpen = true"
          >
            重命名
          </button>
          <button
            type="button"
            class="sheet-item"
            :disabled="locked || busy"
            @click="openMove"
          >
            移动到文件夹
          </button>
          <button
            type="button"
            class="sheet-item is-danger"
            :disabled="locked || busy"
            @click="deleteOpen = true"
          >
            删除
          </button>

          <button type="button" class="sheet-item is-cancel" @click="emit('close')">取消</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <AppDialog
    :open="renameOpen"
    title="重命名"
    confirm-label="保存"
    :busy="busy"
    @close="renameOpen = false"
    @confirm="submitRename"
  >
    <input
      v-model="renameName"
      class="dialog-input"
      type="text"
      placeholder="笔记标题"
      maxlength="200"
      @keyup.enter="submitRename"
    />
    <p class="tip">标题就是文件名，改名会一并重命名网盘上的文件；同名附件目录也会跟着改。</p>
  </AppDialog>

  <MoveDialog
    :open="moveOpen"
    :busy="busy"
    @close="moveOpen = false"
    @pick="moveTo"
  />

  <AppDialog
    :open="deleteOpen"
    title="删除这篇笔记？"
    confirm-label="移入回收站"
    danger
    :busy="busy"
    @close="deleteOpen = false"
    @confirm="softDelete"
  >
    <p class="tip">笔记将进入回收站，30 天内可恢复；附件会跟着一起走。</p>
  </AppDialog>
</template>

<style scoped>
/*
 * .sheet-mask / .sheet / .sheet-item 以及它们的入场动画都在 styles/app.css
 * （全局一份，四个底部弹层共用）—— 这里只留本组件独有的输入框与说明文字。
 * 层级：侧栏 20 < 本菜单 21 < AppDialog 22 < .toast 30，见 docs/ui-patterns.md。
 */
.dialog-input {
  width: 100%;
  height: 44px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-size: 15px;
}

.tip {
  margin-top: var(--sp-1);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
</style>
