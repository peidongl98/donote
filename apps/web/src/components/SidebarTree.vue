<script setup lang="ts">
/**
 * 侧栏的文件夹树。
 *
 * 数据只有一份来源：`foldersApi.list()` + `notesApi.list()` —— 两者都走 `tree()`，
 * 与笔记列表页共用同一次目录遍历（`treeCache` / `treePending` 去重），
 * 所以侧栏挂上去**不额外多发一个请求**（核实见 `docs/sidebar-tree-plan.md`）。
 *
 * 结构：全部笔记 / 文件夹树 / 回收站 / 设置 由 AppSidebar 排；这里只管树。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { FolderDTO, NoteSummaryDTO } from '@donote/shared';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { DavError, foldersApi, notesApi } from '@/storage/notes';
import { useLayoutStore } from '@/stores/layout';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { ancestorFolderIds, buildSidebarRows, type SidebarRow } from '@/utils/sidebar-tree';
import AppDialog from '@/components/AppDialog.vue';

/** 按**展开的文件夹 id**（base64url）记，与 layout store 的 `donote.sidebar` 是两个 key */
const EXPANDED_KEY = 'donote.sidebar.expanded';

const route = useRoute();
const router = useRouter();
const layout = useLayoutStore();
const sync = useSyncStore();
const ui = useUiStore();

const folders = ref<FolderDTO[]>([]);
const notes = ref<NoteSummaryDTO[]>([]);

function readExpanded(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
}

const expanded = ref<Set<string>>(readExpanded());

function persist(): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded.value]));
  } catch {
    // 无痕模式等写不进去：当次会话内照常工作，不打断用户
  }
}

const rows = computed(() => buildSidebarRows(folders.value, notes.value, expanded.value));

/** 路由里正在看的是哪一条（高亮用） */
const currentNoteId = computed(() => (route.name === 'note' ? String(route.params.id ?? '') : ''));
const currentFolderId = computed(() =>
  route.name === 'folder' ? String(route.params.id ?? '') : '',
);

function expand(id: string): void {
  if (!id || expanded.value.has(id)) return;
  expanded.value = new Set(expanded.value).add(id);
  persist();
}

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
  persist();
}

/** 点文件夹行展开/折叠；点笔记行不动（笔记没有可展开的东西） */
function onRowClick(row: SidebarRow): void {
  if (row.kind === 'folder') toggle(row.folder.id);
}

async function load(): Promise<void> {
  try {
    const [folderList, noteList] = await Promise.all([
      foldersApi.list(),
      notesApi.list({ limit: 100_000 }),
    ]);
    folders.value = folderList.items;
    notes.value = noteList.items;
  } catch {
    // 侧栏加载失败不打断页面：留着上一次的内容，下一次 dataVersion 变化会再试
  }
}

/**
 * 进到某条笔记就把它的祖先链展开。
 * 不做这一步，「当前笔记高亮」在折叠态下等于没做 —— 高亮的那一行根本没渲染。
 */
function revealCurrent(): void {
  const id = currentNoteId.value;
  if (!id) return;
  const note = notes.value.find((item) => item.id === id);
  if (!note) return;
  const chain = ancestorFolderIds(folders.value, note.folder_id);
  if (!chain.length || chain.every((folderId) => expanded.value.has(folderId))) return;
  const next = new Set(expanded.value);
  for (const folderId of chain) next.add(folderId);
  expanded.value = next;
  persist();
}

async function refresh(): Promise<void> {
  await load();
  revealCurrent();
}

onMounted(refresh);
/** 缓存层后台校验出云端有更新：重取一次（`invalidateTree()` 已由 subscribeData 调过） */
watch(() => sync.dataVersion, refresh);
watch(() => route.fullPath, revealCurrent);

/* ------------------------------ 行内操作 ------------------------------ */

const menuTarget = ref<FolderDTO | null>(null);
const creating = ref(false);

const createOpen = ref(false);
const createParentId = ref<string | null>(null);
const createName = ref('');

const renameOpen = ref(false);
const renameTarget = ref<FolderDTO | null>(null);
const renameName = ref('');

const deleteOpen = ref(false);
const deleteTarget = ref<FolderDTO | null>(null);

const busy = ref(false);

/** 在这个文件夹下新建一篇笔记，直接进详情页 */
async function newNoteIn(folder: FolderDTO): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const res = await notesApi.create({ title: '', content: '', folder_id: folder.id });
    expand(folder.id);
    layout.close();
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败，请稍后重试');
  } finally {
    creating.value = false;
  }
}

function openCreate(parent: FolderDTO): void {
  menuTarget.value = null; // 底部弹层 z-index 21 比 AppDialog 22 低不了——先关掉再开对话框
  createParentId.value = parent.id;
  createName.value = '';
  createOpen.value = true;
}

function openRename(folder: FolderDTO): void {
  menuTarget.value = null;
  renameTarget.value = folder;
  renameName.value = folder.name;
  renameOpen.value = true;
}

function openDelete(folder: FolderDTO): void {
  menuTarget.value = null;
  deleteTarget.value = folder;
  deleteOpen.value = true;
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim();
  if (!name) {
    ui.toast('请输入文件夹名称');
    return;
  }
  busy.value = true;
  try {
    await foldersApi.create({ name, parent_id: createParentId.value });
    createOpen.value = false;
    // 新建在折叠着的文件夹下，不展开的话用户看不到结果，会以为没成功
    if (createParentId.value) expand(createParentId.value);
    ui.toast('已创建');
    await load();
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '创建失败');
  } finally {
    busy.value = false;
  }
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
</script>

<template>
  <div class="tree">
    <p v-if="!rows.length" class="tree-empty">还没有文件夹</p>

    <div
      v-for="row in rows"
      :key="row.kind === 'folder' ? row.folder.id : row.note.id"
      class="tree-row"
      :class="{
        'is-branch': row.kind === 'folder',
        'is-current':
          (row.kind === 'note' && row.note.id === currentNoteId) ||
          (row.kind === 'folder' && row.folder.id === currentFolderId),
      }"
      :style="{ paddingLeft: `${row.depth * 18}px` }"
      @click="onRowClick(row)"
    >
      <template v-if="row.kind === 'folder'">
        <button
          v-if="row.hasChildren"
          class="twist"
          type="button"
          :aria-expanded="row.expanded"
          :aria-label="row.expanded ? '折叠' : '展开'"
          @click.stop="toggle(row.folder.id)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="m9 6 6 6-6 6"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <span v-else class="twist" aria-hidden="true" />

        <RouterLink
          class="tree-link"
          :to="`/folders/${row.folder.id}`"
          @click.stop="layout.close()"
        >
          <span class="tree-label">📁 {{ row.folder.name }}</span>
        </RouterLink>
        <!-- 名字只占自己的宽度，右边这片留给「点行 = 展开折叠」。
             名字撑满整行的话，用户点哪儿都是跳转，等于没有「点行折叠」这个操作 -->
        <span class="tree-fill" />

        <span class="tree-actions">
          <button
            class="act"
            type="button"
            :disabled="creating"
            aria-label="在此文件夹新建笔记"
            @click.stop="newNoteIn(row.folder)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d="M12 6v12M6 12h12"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
          <button
            class="act"
            type="button"
            aria-label="文件夹操作"
            @click.stop="menuTarget = row.folder"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="19" cy="12" r="1.7" fill="currentColor" />
            </svg>
          </button>
        </span>
      </template>

      <template v-else>
        <span class="twist" aria-hidden="true" />
        <RouterLink
          class="tree-link"
          :to="`/notes/${row.note.id}`"
          @click.stop="layout.close()"
        >
          <span class="tree-label">📄 {{ row.note.title }}</span>
        </RouterLink>
      </template>
    </div>
  </div>

  <!-- 文件夹行的「⋯」：与 /folders 页同一套能力，但落成贴在栏里的小弹层 -->
  <Teleport to="body">
    <Transition name="tree-menu">
      <div v-if="menuTarget" class="menu-mask" @click.self="menuTarget = null">
        <div class="menu glass">
          <p class="menu-title">📁 {{ menuTarget.name }}</p>
          <button type="button" class="menu-item" @click="openCreate(menuTarget)">新建子文件夹</button>
          <button type="button" class="menu-item" @click="openRename(menuTarget)">重命名</button>
          <button type="button" class="menu-item is-danger" @click="openDelete(menuTarget)">
            解散文件夹
          </button>
          <button type="button" class="menu-item is-cancel" @click="menuTarget = null">取消</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <AppDialog
    :open="createOpen"
    title="新建子文件夹"
    confirm-label="创建"
    :busy="busy"
    @close="createOpen = false"
    @confirm="submitCreate"
  >
    <input v-model="createName" class="menu-input" type="text" placeholder="文件夹名称" maxlength="60" />
  </AppDialog>

  <AppDialog
    :open="renameOpen"
    title="重命名"
    confirm-label="保存"
    :busy="busy"
    @close="renameOpen = false"
    @confirm="submitRename"
  >
    <input v-model="renameName" class="menu-input" type="text" maxlength="60" />
  </AppDialog>

  <AppDialog
    :open="deleteOpen"
    title="解散这个文件夹？"
    confirm-label="解散"
    danger
    :busy="busy"
    @close="deleteOpen = false"
    @confirm="submitDelete"
  >
    <p class="menu-tip">
      「{{ deleteTarget?.name }}」里的 {{ deleteTarget?.note_count ?? 0 }}
      篇笔记和子文件夹会移动到上一级，笔记不会被删除。
    </p>
  </AppDialog>
</template>

<style scoped>
.tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 行自己带左右 4px，滚动条不贴边 */
  padding: 2px 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tree-empty {
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  opacity: 0.75;
}

.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: var(--r-xs);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.tree-row:hover {
  background: var(--surface);
  color: var(--text);
}

.tree-row.is-current {
  background: var(--rail-active);
  color: var(--text);
  font-weight: 600;
}

/* 展开箭头；没有子项时同尺寸占位，名字才对得齐 */
.twist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 24px;
  flex: none;
  color: var(--text-2);
  border-radius: var(--r-xs);
}

button.twist svg {
  transition: transform var(--dur-fast) var(--ease-smooth);
}

button.twist[aria-expanded='true'] svg {
  transform: rotate(90deg);
}

button.twist:hover {
  color: var(--text);
}

.tree-link {
  min-width: 0;
  display: flex;
  align-items: center;
  height: 30px;
  padding-right: 4px;
  color: inherit;
  text-decoration: none;
}

/* 文件夹行：名字只占自己的宽度，剩下的给 .tree-fill（点它 = 展开折叠） */
.tree-row.is-branch .tree-link {
  flex: 0 1 auto;
}

/* 笔记行：整行都算这一条，点到哪儿都进详情 */
.tree-row:not(.is-branch) .tree-link {
  flex: 1 1 auto;
}

.tree-fill {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 0;
}

.tree-label {
  min-width: 0;
  font-size: var(--fs-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 悬停按钮留在流里、只改透明度：不占位会让标题在悬停时横向跳，绝对定位又要跟 glass 的层级打架 */
.tree-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.tree-row:hover .tree-actions,
.tree-actions:focus-within {
  opacity: 1;
  pointer-events: auto;
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.act:hover:not(:disabled) {
  background: var(--rail-active);
  color: var(--text);
}

.act:disabled {
  opacity: 0.5;
}

/* ------------------------------ 行操作弹层 ------------------------------ */

/*
 * z-index 21：压在侧栏（20）与移动端遮罩（19）之上，又在 AppDialog（22）之下。
 *
 * 遮罩铺满视口，内容盒收进**内容列** —— 加一条 padding-left = 侧栏让出的宽度，
 * 里面的 .menu 就居中于内容区而不是视口，不会横跨到侧栏上。
 * ⚠️ 侧栏只有 260px，放不下这个 720px 的面板，所以它在内容列居中而不是栏内居中；
 * 真正的「栏内居中小弹层」是另一套排版，别混用。
 */
.menu-mask {
  position: fixed;
  inset: 0;
  padding-left: var(--content-offset);
  z-index: 21;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.38);
}

.menu {
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

.menu-title {
  padding: var(--sp-1) var(--sp-2) 4px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-item {
  height: 50px;
  border-radius: var(--r-md);
  font-size: 16px;
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.menu-item:hover {
  background: var(--surface);
}

.menu-item.is-danger {
  color: var(--danger);
}

.menu-item.is-cancel {
  color: var(--text-2);
  margin-top: 4px;
}

.menu-input {
  width: 100%;
  height: 44px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-size: 15px;
}

.menu-tip {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}

.tree-menu-enter-active,
.tree-menu-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.tree-menu-enter-active .menu,
.tree-menu-leave-active .menu {
  transition: transform var(--dur) var(--ease-spring);
}

.tree-menu-enter-from,
.tree-menu-leave-to {
  opacity: 0;
}

.tree-menu-enter-from .menu,
.tree-menu-leave-to .menu {
  transform: translateY(100%);
}
</style>
