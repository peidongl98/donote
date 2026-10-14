<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { FolderDTO } from '@donote/shared';
import { DavError, foldersApi } from '@/storage/notes';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { flattenFolders, pickableFolders } from '@/utils/folder-tree';
import { useLongPress } from '@/utils/long-press';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import BatchToolbar from '@/components/BatchToolbar.vue';
import EmptyState from '@/components/EmptyState.vue';

const folders = ref<FolderDTO[]>([]);
const loading = ref(true);
const ui = useUiStore();
const sync = useSyncStore();
const sel = useSelectionStore();

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

/* 移动到… */
const moveOpen = ref(false);
const moveTarget = ref<FolderDTO | null>(null);

/** 按 parent_id 组树后再拉平，带缩进层级（与批量移动共用 utils/folder-tree） */
const rows = computed(() => flattenFolders(folders.value));

const totalNotes = computed(() => folders.value.reduce((sum, f) => sum + f.note_count, 0));

/**
 * 「移动到…」里可选的目标：排掉自己和自己的整棵子树。
 * 数据层的 `foldersApi.move` 另有同样的拒绝逻辑 —— 这里只是不把死路摆到用户面前，
 * 不是唯一防线。
 */
const moveOptions = computed(() =>
  pickableFolders(folders.value, moveTarget.value ? [moveTarget.value.id] : []),
);

/* ------------------------------ 多选 ------------------------------ */

/** 选中，但只认当前列表里还在的 */
const selectedIds = computed(() =>
  folders.value.map((f) => f.id).filter((id) => sel.has(id)),
);
const allIds = computed(() => folders.value.map((f) => f.id));
/** 批量移动的目标：同样要排掉**每一个**选中的文件夹及其子树（单条规则取并集） */
const batchTargets = computed(() => pickableFolders(folders.value, selectedIds.value));
const labelOf = (id: string): string =>
  folders.value.find((f) => f.id === id)?.name ?? '这个文件夹';

/** 长按：一次只可能有一条被按住，所以复用同一个计时器 */
const pressId = ref('');
const press = useLongPress(() => enterSelect(pressId.value));

function startPress(id: string, event: PointerEvent): void {
  pressId.value = id;
  press.start(event);
}

function enterSelect(id: string): void {
  if (!sel.selecting) sel.enterSelecting('folders');
  if (id) sel.toggle(id);
}

function onPick(folder: FolderDTO): void {
  if (sel.selecting) sel.toggle(folder.id);
  else enterSelect(folder.id);
}

/**
 * 多选态和长按都要拦掉跳转。
 * 🔴 必须在**捕获阶段**：`RouterLink` 自己的 onClick 挂在 `<a>` 上、在目标阶段跑，
 * 比模板里的冒泡处理器更早，靠冒泡 `preventDefault` 拦不住（实测会照跳）。
 */
function onRowCapture(event: MouseEvent, folder: FolderDTO): void {
  if ((event.target as HTMLElement | null)?.closest('button')) return;
  const long = press.consume();
  if (!sel.selecting && !long) return;
  event.preventDefault();
  event.stopPropagation();
  if (sel.selecting && !long) sel.toggle(folder.id);
}

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

function openMove(folder: FolderDTO): void {
  // 与其它 open* 一样顺手关掉列表弹层：弹层已归到 z-index 21（见 styles/app.css），
  // AppDialog(22) 本来就盖得住它，关掉只是为了让用户点完对话框回到干净的页面。
  sheetTarget.value = null;
  moveTarget.value = folder;
  moveOpen.value = true;
}

async function submitMove(parentId: string | null): Promise<void> {
  const target = moveTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    const res = await foldersApi.move(target.id, parentId);
    moveOpen.value = false;
    const where = parentId
      ? (folders.value.find((f) => f.id === parentId)?.name ?? '目标文件夹')
      : '根目录';
    // 撞名时查重补过后缀，此时说清楚落盘的名字，别让用户以为没生效
    ui.toast(
      res.folder.name === target.name
        ? `已移动到「${where}」`
        : `「${where}」已有同名，已存为「${res.folder.name}」`,
    );
    await load();
  } catch (err) {
    // 防环等拒绝理由由数据层给出，直接透传
    ui.toast(err instanceof DavError ? err.message : '移动失败');
  } finally {
    busy.value = false;
  }
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

/** 缓存层在后台校验出云端有更新，列表跟着刷一次 */
watch(() => sync.dataVersion, load);
</script>

<template>
  <div class="page">
    <AppHeader :crumbs="[{ label: '文件夹' }]" />

    <div class="page-body">
      <button class="btn-major full" type="button" @click="openCreate(null)">新建文件夹</button>

      <p class="section-title">
        {{ folders.length ? `${folders.length} 个 · ${totalNotes} 篇笔记` : '用文件夹归类笔记' }}
      </p>

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
          :class="{ 'is-selectable': sel.selecting, 'is-selected': sel.has(row.folder.id) }"
          :style="{ paddingLeft: `calc(var(--sp-2) + ${row.depth * 18}px)` }"
          @click.capture="onRowCapture($event, row.folder)"
          @pointerdown="startPress(row.folder.id, $event)"
          @pointerup="press.cancel"
          @pointercancel="press.cancel"
          @pointerleave="press.cancel"
        >
          <button
            type="button"
            class="pick"
            :aria-pressed="sel.has(row.folder.id)"
            :aria-label="sel.has(row.folder.id) ? '取消选择' : '选择'"
            @click.stop="onPick(row.folder)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="m5 12.5 4.5 4.5L19 7.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <RouterLink class="folder-link" :to="`/folders/${row.folder.id}`">
            <span class="folder-name">📁 {{ row.folder.name }}</span>
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

    <BatchToolbar
      v-if="sel.selecting"
      context="folders"
      :ids="selectedIds"
      :all-ids="allIds"
      :label-of="labelOf"
      :targets="batchTargets"
      @done="load"
    />

    <!-- 行内操作 -->
    <Teleport to="body">
      <Transition name="sheet">
        <div v-if="sheetTarget" class="sheet-mask" @click.self="sheetTarget = null">
          <div class="sheet glass">
            <p class="sheet-title">{{ sheetTarget.name }}</p>
            <button type="button" class="sheet-item" @click="openCreate(sheetTarget.id)">新建子文件夹</button>
            <button type="button" class="sheet-item" @click="openRename(sheetTarget)">重命名</button>
            <button type="button" class="sheet-item" @click="openMove(sheetTarget)">移动到…</button>
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

    <AppDialog
      :open="moveOpen"
      title="移动到"
      confirm-label="关闭"
      :busy="busy"
      @close="moveOpen = false"
      @confirm="moveOpen = false"
    >
      <div class="folder-list">
        <button
          v-for="row in [{ folder: null, depth: 0 }, ...moveOptions]"
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
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition:
    transform var(--dur) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-smooth);
}

.folder-row:hover {
  transform: translateY(-1px);
}

.folder-row.is-selected {
  background: var(--accent-soft);
}

/* 悬停勾选框：桌面端进多选的入口；收起时不占点击，不挡名字上的跳转 */
.pick {
  position: absolute;
  top: 50%;
  left: 8px;
  transform: translateY(-50%);
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--surface-border);
  background: var(--surface);
  color: transparent;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth),
    border-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.folder-row:hover .pick,
.folder-row.is-selectable .pick,
.pick:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.pick:hover {
  border-color: var(--accent);
}

.pick[aria-pressed='true'] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

/* 「移动到…」的候选清单样式在 styles/app.css —— 批量移动复用同一套。
   勾选框固定在最左、不参与行内缩进；名字的起点（行 padding + link padding）本来就够它让位。 */
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

/*
 * .sheet-mask / .sheet / .sheet-item 与入场动画都在 styles/app.css（全局一份，四个底部弹层共用）。
 * 层级：侧栏 20 < 弹层 21 < AppDialog 22 < .toast 30 —— 弹层从 25 降到 21 之后，
 * 「先关掉 sheet 再开对话框」就不再是必需的了（对话框本来就盖得住它）。
 */

</style>
