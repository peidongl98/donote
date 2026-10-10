<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FolderDTO, NoteSummaryDTO } from '@donote/shared';
import { DavError, foldersApi, notesApi } from '@/storage/notes';
import { useEditingStore } from '@/stores/editing';
import { useUiStore } from '@/stores/ui';
import AppDialog from '@/components/AppDialog.vue';

/**
 * 笔记动作菜单：右键卡片或点卡片右上角「更多」都会开它。
 * mode='trash' 时换成回收站的两项（恢复 / 彻底删除）。
 *
 * 菜单本身的 z-index 压得比 AppDialog 低，这样点开重命名 / 移动时，
 * 对话框盖在菜单上面，不需要先把菜单关掉。
 */
const props = defineProps<{
  note: NoteSummaryDTO | null;
  mode?: 'normal' | 'trash';
}>();

const emit = defineEmits<{ close: []; done: [] }>();

const ui = useUiStore();
const editing = useEditingStore();

const renameOpen = ref(false);
const renameName = ref('');
const moveOpen = ref(false);
const deleteOpen = ref(false);
const hardOpen = ref(false);
const busy = ref(false);
const folders = ref<FolderDTO[]>([]);

/** 这篇正在编辑中（详情页开着它），重命名 / 移动 / 删除先禁掉 */
const locked = computed(() => Boolean(props.note) && editing.editingNoteId === props.note?.id);
const inTrash = computed(() => props.mode === 'trash');

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

async function openMove(): Promise<void> {
  moveOpen.value = true;
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    // 拉不到文件夹就只留「未归类」，不阻塞移动
  }
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
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

async function restore(): Promise<void> {
  const note = props.note;
  if (!note) return;
  busy.value = true;
  try {
    await notesApi.restore(note.id);
    finish('已恢复');
  } catch {
    ui.toast('恢复失败');
  } finally {
    busy.value = false;
  }
}

async function hardDelete(): Promise<void> {
  const note = props.note;
  if (!note) return;
  busy.value = true;
  try {
    await notesApi.remove(note.id, true);
    hardOpen.value = false;
    finish('已彻底删除');
  } catch {
    ui.toast('删除失败');
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

          <template v-if="inTrash">
            <button type="button" class="sheet-item" :disabled="locked || busy" @click="restore">
              恢复
            </button>
            <button
              type="button"
              class="sheet-item is-danger"
              :disabled="locked || busy"
              @click="hardOpen = true"
            >
              彻底删除
            </button>
          </template>

          <template v-else>
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
          </template>

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

  <AppDialog
    :open="moveOpen"
    title="移动到"
    confirm-label="关闭"
    :busy="busy"
    @close="moveOpen = false"
    @confirm="moveOpen = false"
  >
    <div class="folder-list">
      <button type="button" class="folder-pick" @click="moveTo(null)">未归类</button>
      <button
        v-for="f in folders"
        :key="f.id"
        type="button"
        class="folder-pick"
        @click="moveTo(f.id)"
      >
        {{ f.name }}
      </button>
    </div>
  </AppDialog>

  <AppDialog
    :open="deleteOpen"
    title="删除这篇笔记？"
    confirm-label="移入回收站"
    danger
    :busy="busy"
    @close="deleteOpen = false"
    @confirm="softDelete"
  >
    <p class="tip">文件会挪到同步目录的 .trash 里，随时可以恢复；附件会跟着一起走。</p>
  </AppDialog>

  <AppDialog
    :open="hardOpen"
    title="彻底删除？"
    confirm-label="彻底删除"
    danger
    :busy="busy"
    @close="hardOpen = false"
    @confirm="hardDelete"
  >
    <p class="tip">这一步不可恢复，文件和它的附件会被从你的网盘里真正删掉。</p>
  </AppDialog>
</template>

<style scoped>
/* 比 AppDialog 的 20 低，对话框才能盖在菜单上面 */
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 18;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.38);
}

.sheet {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-1);
  padding-bottom: calc(var(--sp-1) + env(safe-area-inset-bottom, 0px));
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sheet-title {
  padding: var(--sp-1) var(--sp-2) 4px;
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sheet-lock {
  padding: 0 var(--sp-2) var(--sp-1);
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
}

.sheet-item {
  height: 50px;
  border-radius: var(--r-md);
  font-size: 16px;
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.sheet-item:hover:not(:disabled) {
  background: var(--surface);
}

.sheet-item:disabled {
  opacity: 0.4;
}

.sheet-item.is-danger {
  color: var(--danger);
}

.sheet-item.is-cancel {
  color: var(--text-2);
  margin-top: 4px;
}

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

.folder-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
}

.folder-pick {
  padding: 11px var(--sp-2);
  border-radius: var(--r-md);
  text-align: left;
  font-size: 15px;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.sheet-enter-active .sheet,
.sheet-leave-active .sheet {
  transition: transform var(--dur) var(--ease-spring);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet,
.sheet-leave-to .sheet {
  transform: translateY(100%);
}
</style>
