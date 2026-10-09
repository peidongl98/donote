<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { FolderDTO, NoteDTO } from '@donote/shared';
import { DavError, foldersApi, notesApi } from '@/storage/notes';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();

/** 标题即文件名，改名会换 id，所以这里必须是响应式的 */
const noteId = ref(String(route.params.id));
const note = ref<NoteDTO | null>(null);
const title = ref('');
const content = ref('');
const status = ref<SaveStatus>('idle');
const loading = ref(true);
const mode = ref<'edit' | 'preview'>('edit');

const folders = ref<FolderDTO[]>([]);
const sheetOpen = ref(false);
const moveOpen = ref(false);
const deleteOpen = ref(false);
const hardDeleteOpen = ref(false);
const busy = ref(false);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let pending = false;

const isTrashed = computed(() => note.value?.deleted_at != null);
const folderName = computed(() => {
  const id = note.value?.folder_id;
  if (!id) return '未归类';
  return folders.value.find((f) => f.id === id)?.name ?? '未归类';
});

const statusText = computed(() => {
  switch (status.value) {
    case 'dirty':
      return '未保存';
    case 'saving':
      return '保存中…';
    case 'saved':
      return '已保存';
    case 'error':
      return '保存失败';
    default:
      return '';
  }
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await notesApi.get(noteId.value);
    note.value = res.note;
    // loading 期间输入框是 disabled 的，这里赋值不会覆盖用户已输入的内容
    title.value = res.note.title;
    content.value = res.note.content;
    status.value = 'idle';
  } catch (err) {
    if (err instanceof DavError && err.status === 404) {
      ui.toast('笔记不存在');
      await router.replace('/');
      return;
    }
    ui.toast('笔记加载失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 保存：同一时刻只允许一个请求在飞；飞行中产生的新改动会排队再存一次，
 * 避免「连打两个字触发两次并发写入，后发的先到 → 内容回退」。
 */
async function save(): Promise<void> {
  if (isTrashed.value) return;
  if (saving) {
    pending = true;
    return;
  }
  saving = true;
  status.value = 'saving';
  const payload = { title: title.value.trim() || '无标题笔记', content: content.value };
  try {
    const res = await notesApi.update(noteId.value, payload);
    if (res.note) {
      note.value = res.note;
      // 标题改了会连带把文件改名，路由要跟上新的 id
      if (res.note.id !== noteId.value) {
        noteId.value = res.note.id;
        await router.replace(`/notes/${noteId.value}`);
      }
    }
    status.value = 'saved';
  } catch (err) {
    status.value = 'error';
    ui.toast(err instanceof DavError ? err.message : '保存失败，请检查网络');
  } finally {
    saving = false;
    if (pending) {
      pending = false;
      void save();
    }
  }
}

function scheduleSave(): void {
  status.value = 'dirty';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 1200);
}

function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (status.value === 'dirty') void save();
}

/* --------------------------- 移动 --------------------------- */

async function moveTo(folderId: string | null): Promise<void> {
  busy.value = true;
  try {
    const res = await notesApi.update(noteId.value, { folder_id: folderId });
    if (res.note) {
      note.value = res.note;
      if (res.note.id !== noteId.value) {
        noteId.value = res.note.id;
        await router.replace(`/notes/${noteId.value}`);
      }
    }
    ui.toast(folderId ? '已移动' : '已移到未归类');
    moveOpen.value = false;
  } catch {
    ui.toast('移动失败');
  } finally {
    busy.value = false;
  }
}

/* --------------------------- 删除 --------------------------- */

async function softDelete(): Promise<void> {
  busy.value = true;
  try {
    await notesApi.remove(noteId.value);
    ui.toast('已移入回收站');
    await router.replace('/');
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
    deleteOpen.value = false;
  }
}

async function hardDelete(): Promise<void> {
  busy.value = true;
  try {
    await notesApi.remove(noteId.value, true);
    ui.toast('已彻底删除');
    await router.replace('/trash');
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
    hardDeleteOpen.value = false;
  }
}

async function restore(): Promise<void> {
  busy.value = true;
  try {
    const res = await notesApi.restore(noteId.value);
    ui.toast('已恢复');
    noteId.value = res.note.id;
    await router.replace(`/notes/${noteId.value}`);
    await load();
  } catch {
    ui.toast('恢复失败');
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    // 文件夹列表拉取失败只影响「移动」弹窗，不阻塞编辑
  }
});

onBeforeUnmount(flush);
</script>

<template>
  <div class="editor">
    <AppHeader :title="isTrashed ? '回收站中的笔记' : '编辑'" back>
      <template #actions>
        <span class="status mono" :class="`is-${status}`">{{ statusText }}</span>
        <button class="more" type="button" aria-label="更多操作" @click="sheetOpen = true">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" fill="currentColor" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" />
          </svg>
        </button>
      </template>
    </AppHeader>

    <div v-if="isTrashed" class="trash-bar">
      <span>这篇笔记在回收站里，恢复后会回到原来的文件夹。</span>
      <button type="button" class="btn-ghost small" :disabled="busy" @click="restore">恢复</button>
    </div>

    <div class="body">
      <input
        v-model="title"
        class="title-input"
        type="text"
        placeholder="无标题笔记"
        maxlength="200"
        aria-label="笔记标题"
        :disabled="loading || isTrashed"
        @input="scheduleSave"
      />

      <div class="tabs">
        <button
          type="button"
          class="seg"
          :class="{ 'is-on': mode === 'edit' }"
          @click="mode = 'edit'"
        >
          编辑
        </button>
        <button
          type="button"
          class="seg"
          :class="{ 'is-on': mode === 'preview' }"
          @click="mode = 'preview'"
        >
          预览
        </button>
        <span class="where">· {{ folderName }}</span>
      </div>

      <div v-if="loading" class="skeleton" />

      <textarea
        v-else-if="mode === 'edit'"
        v-model="content"
        class="content-input mono"
        placeholder="用 Markdown 写点什么…"
        spellcheck="false"
        :readonly="isTrashed"
        @input="scheduleSave"
      />

      <div v-else class="preview">
        <MarkdownView :source="content" empty="暂无内容" />
      </div>
    </div>

    <!-- 更多操作 -->
    <Teleport to="body">
      <Transition name="sheet">
        <div v-if="sheetOpen" class="sheet-mask" @click.self="sheetOpen = false">
          <div class="sheet glass">
            <button
              type="button"
              class="sheet-item"
              :disabled="isTrashed"
              @click="sheetOpen = false; moveOpen = true"
            >
              移动到文件夹
            </button>
            <button
              v-if="!isTrashed"
              type="button"
              class="sheet-item is-danger"
              @click="sheetOpen = false; deleteOpen = true"
            >
              删除
            </button>
            <button
              v-else
              type="button"
              class="sheet-item is-danger"
              @click="sheetOpen = false; hardDeleteOpen = true"
            >
              彻底删除
            </button>
            <button type="button" class="sheet-item is-cancel" @click="sheetOpen = false">取消</button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 移动到文件夹 -->
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
          :class="{ 'is-on': f.id === note?.folder_id }"
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
      <p class="tip">文件会挪到同步目录的 .trash 里，随时可以恢复。</p>
    </AppDialog>

    <AppDialog
      :open="hardDeleteOpen"
      title="彻底删除？"
      confirm-label="彻底删除"
      danger
      :busy="busy"
      @close="hardDeleteOpen = false"
      @confirm="hardDelete"
    >
      <p class="tip">这一步不可恢复，文件会被从坚果云里真正删掉。</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.editor {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.status {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.status.is-error {
  color: var(--danger);
}

.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--r-pill);
  color: var(--text-2);
  transition: color var(--dur-fast) var(--ease-smooth);
}

.more:hover {
  color: var(--text);
}

.trash-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-2);
  font-size: 13px;
  color: var(--danger);
  background: var(--danger-soft);
}

.btn-ghost.small {
  height: 32px;
  padding: 0 var(--sp-2);
  font-size: 13px;
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-2);
  gap: var(--sp-1);
}

.title-input {
  width: 100%;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.01em;
  padding: var(--sp-1) 0;
  background: none;
  border: none;
}

.title-input::placeholder {
  color: var(--text-2);
  opacity: 0.55;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}

.seg {
  padding: 5px 14px;
  border-radius: var(--r-pill);
  font-size: 13px;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition:
    color var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth);
}

.seg.is-on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}

.where {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.content-input,
.preview {
  flex: 1 1 auto;
  min-height: 46vh;
  padding: var(--sp-2);
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-size: 15px;
  line-height: 1.75;
  resize: none;
  overflow-y: auto;
}

.preview {
  overflow-y: auto;
}

.skeleton {
  flex: 1 1 auto;
  min-height: 46vh;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}

.field input,
.field select {
  height: 42px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text);
  font-size: 15px;
}

.tip {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}

.link {
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
  word-break: break-all;
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

.folder-pick.is-on {
  color: var(--accent);
  border-color: var(--accent-ring);
}

/* 底部动作面板 */
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 25;
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
