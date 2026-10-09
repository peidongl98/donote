<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { FolderDTO } from '@donote/shared';
import { DavError, foldersApi } from '@/storage/notes';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import EmptyState from '@/components/EmptyState.vue';

const folders = ref<FolderDTO[]>([]);
const loading = ref(true);
const ui = useUiStore();

const createOpen = ref(false);
const createParent = ref<string | null>(null);
const createName = ref('');

const renameOpen = ref(false);
const renameTarget = ref<FolderDTO | null>(null);
const renameName = ref('');

const deleteOpen = ref(false);
const deleteTarget = ref<FolderDTO | null>(null);
const sheetTarget = ref<FolderDTO | null>(null);
const busy = ref(false);

/** 按 parent_id 组树后再拉平，带缩进层级 */
const rows = computed(() => {
  const byParent = new Map<string | null, FolderDTO[]>();
  for (const f of folders.value) {
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f);
    byParent.set(f.parent_id, list);
  }
  const out: { folder: FolderDTO; depth: number }[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const f of byParent.get(parent) ?? []) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
});

const totalNotes = computed(() => folders.value.reduce((sum, f) => sum + f.note_count, 0));

async function load(): Promise<void> {
  loading.value = true;
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    ui.toast('文件夹加载失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(parentId: string | null): void {
  sheetTarget.value = null;
  createParent.value = parentId;
  createName.value = '';
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim();
  if (!name) {
    ui.toast('请输入文件夹名称');
    return;
  }
  busy.value = true;
  try {
    await foldersApi.create({ name, parent_id: createParent.value });
    createOpen.value = false;
    ui.toast('已创建');
    await load();
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '创建失败');
  } finally {
    busy.value = false;
  }
}

function openRename(folder: FolderDTO): void {
  sheetTarget.value = null;
  renameTarget.value = folder;
  renameName.value = folder.name;
  renameOpen.value = true;
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value;
  const name = renameName.value.trim();
  if (!target || !name) return;
  busy.value = true;
  try {
    await foldersApi.rename(target.id, name);
    renameOpen.value = false;
    ui.toast('已重命名');
    await load();
  } catch {
    ui.toast('重命名失败');
  } finally {
    busy.value = false;
  }
}

function openDelete(folder: FolderDTO): void {
  sheetTarget.value = null;
  deleteTarget.value = folder;
  deleteOpen.value = true;
}

async function submitDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await foldersApi.remove(target.id);
    deleteOpen.value = false;
    ui.toast('文件夹已删除，里面内容已上移到上一级');
    await load();
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <AppHeader title="文件夹" :subtitle="folders.length ? `${folders.length} 个 · ${totalNotes} 篇笔记` : '用文件夹归类笔记'" />

    <div class="page-body">
      <button class="btn-major full" type="button" @click="openCreate(null)">新建文件夹</button>

      <EmptyState v-if="loading" loading title="加载中" />

      <EmptyState v-else-if="!folders.length" title="还没有文件夹" hint="文件夹只是一层归类，删除它不会删掉里面的笔记">
        <template #icon>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path
              d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2.5h6A2.5 2.5 0 0 1 20 10v6.5A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </template>
      </EmptyState>

      <div v-else class="stack list">
        <div
          v-for="row in rows"
          :key="row.folder.id"
          class="folder-row"
          :style="{ paddingLeft: `calc(var(--sp-2) + ${row.depth * 18}px)` }"
        >
          <RouterLink class="folder-link" :to="`/folders/${row.folder.id}`">
            <span class="folder-name">{{ row.folder.name }}</span>
            <span class="folder-count mono">{{ row.folder.note_count }}</span>
          </RouterLink>
          <button class="folder-more" type="button" aria-label="更多" @click="sheetTarget = row.folder">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="19" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 行内操作 -->
    <Teleport to="body">
      <Transition name="sheet">
        <div v-if="sheetTarget" class="sheet-mask" @click.self="sheetTarget = null">
          <div class="sheet glass">
            <p class="sheet-title">{{ sheetTarget.name }}</p>
            <button type="button" class="sheet-item" @click="openCreate(sheetTarget.id)">新建子文件夹</button>
            <button type="button" class="sheet-item" @click="openRename(sheetTarget)">重命名</button>
            <button type="button" class="sheet-item is-danger" @click="openDelete(sheetTarget)">删除文件夹</button>
            <button type="button" class="sheet-item is-cancel" @click="sheetTarget = null">取消</button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <AppDialog
      :open="createOpen"
      :title="createParent ? '新建子文件夹' : '新建文件夹'"
      confirm-label="创建"
      :busy="busy"
      @close="createOpen = false"
      @confirm="submitCreate"
    >
      <input v-model="createName" class="dialog-input" type="text" placeholder="文件夹名称" maxlength="60" />
    </AppDialog>

    <AppDialog
      :open="renameOpen"
      title="重命名"
      confirm-label="保存"
      :busy="busy"
      @close="renameOpen = false"
      @confirm="submitRename"
    >
      <input v-model="renameName" class="dialog-input" type="text" maxlength="60" />
    </AppDialog>

    <AppDialog
      :open="deleteOpen"
      title="删除这个文件夹？"
      confirm-label="删除"
      danger
      :busy="busy"
      @close="deleteOpen = false"
      @confirm="submitDelete"
    >
      <p class="tip">
        「{{ deleteTarget?.name }}」里的 {{ deleteTarget?.note_count ?? 0 }} 篇笔记和子文件夹会移动到上一级，笔记不会被删除。
      </p>
    </AppDialog>
  </div>
</template>

<style scoped>
.btn-major.full {
  width: 100%;
}

.list {
  margin-top: var(--sp-2);
}

.folder-row {
  display: flex;
  align-items: center;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition: transform var(--dur) var(--ease-spring);
}

.folder-row:hover {
  transform: translateY(-1px);
}

.folder-link {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2);
  color: inherit;
}

.folder-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.folder-count {
  font-size: 12px;
  color: var(--text-2);
  flex: none;
}

.folder-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-right: 4px;
  border-radius: var(--r-pill);
  color: var(--text-2);
}

.folder-more:hover {
  color: var(--text);
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
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}

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

.sheet-title {
  padding: var(--sp-1) var(--sp-2) 4px;
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sheet-item {
  height: 50px;
  border-radius: var(--r-md);
  font-size: 16px;
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.sheet-item:hover {
  background: var(--surface);
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
