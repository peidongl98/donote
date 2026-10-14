<script setup lang="ts">
/**
 * 侧栏的文件夹树 + 节点右键菜单。
 *
 * 数据只有一份来源：`foldersApi.list()` + `notesApi.list()` —— 两者都走 `tree()`，
 * 与笔记列表页共用同一次目录遍历（`treeCache` / `treePending` 去重），
 * 所以侧栏挂上去**不额外多发一个请求**（核实见 `docs/sidebar-tree-plan.md`）。
 *
 * 结构：全部笔记 / 文件夹树 / 回收站 / 设置 由 AppSidebar 排；这里只管树。
 *
 * 菜单形态按 `docs/ui-patterns.md` 的「触发场景 → 形态」表：侧栏节点的操作是**贴着节点的
 * popover**（不是内容区那种 bottom sheet），所以位置从鼠标点 / `⋯` 按钮算，不铺满屏。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FolderDTO, NoteSummaryDTO } from '@donote/shared';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { DavError, decodeId, foldersApi, notesApi } from '@/storage/notes';
import { buildExportHtml, saveExportHtml } from '@/services/export-html';
import { useLayoutStore } from '@/stores/layout';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { ancestorFolderIds, buildSidebarRows, type SidebarRow } from '@/utils/sidebar-tree';
import AppDialog from '@/components/AppDialog.vue';
import ImportDialog from '@/components/ImportDialog.vue';
import MoveDialog from '@/components/MoveDialog.vue';

/** 按**展开的文件夹 id**（base64url）记，与 layout store 的 `donote.sidebar` 是两个 key */
const EXPANDED_KEY = 'donote.sidebar.expanded';

const route = useRoute();
const router = useRouter();
const layout = useLayoutStore();
const sync = useSyncStore();
const ui = useUiStore();

/**
 * 重取信号。侧栏顶部的导入按钮和这棵树是兄弟，导入走 `notesApi.create`、不经过
 * `sync.dataVersion`，所以由 AppSidebar 递增这个数字来叫它刷新。
 * 不用模板 ref：树在 `v-for` 里，`ref` 会变成数组，`treeRef.value.refresh` 取不到。
 */
const props = withDefaults(defineProps<{ reloadToken?: number }>(), { reloadToken: 0 });

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
watch(() => props.reloadToken, refresh);

/* ------------------------------ 右键菜单 ------------------------------ */

/**
 * 菜单是**贴着节点**的 popover：位置由触发点算出来，尺寸固定，贴边时翻到另一侧。
 * 三种上下文共用一个浮层，条目在模板里按 kind 分支 —— 不铺满屏，所以不压暗背景。
 */
type MenuKind = 'folder' | 'note' | 'blank';

const MENU_W = 208;
const MENU_H = 336;

const menu = ref<{
  kind: MenuKind;
  folder: FolderDTO | null;
  note: NoteSummaryDTO | null;
  x: number;
  y: number;
} | null>(null);

const menuEl = ref<HTMLElement | null>(null);

function place(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - MENU_H - 8)),
  };
}

function openAt(kind: MenuKind, x: number, y: number, folder: FolderDTO | null, note: NoteSummaryDTO | null): void {
  menu.value = { kind, folder, note, ...place(x, y) };
}

function onRowMenu(row: SidebarRow, event: MouseEvent): void {
  if (row.kind === 'folder') openAt('folder', event.clientX, event.clientY, row.folder, null);
  else openAt('note', event.clientX, event.clientY, null, row.note);
}

/** `⋯` 按钮：菜单贴着按钮下沿，右缘对齐按钮右缘 */
function onDots(kind: MenuKind, target: FolderDTO | NoteSummaryDTO, event: MouseEvent): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const folder = kind === 'folder' ? (target as FolderDTO) : null;
  const note = kind === 'note' ? (target as NoteSummaryDTO) : null;
  openAt(kind, box.right - MENU_W, box.bottom + 4, folder, note);
}

/** 树的空白处（右键点到的就是容器本身，不是某一行） */
function onBlankMenu(event: MouseEvent): void {
  if (event.target !== event.currentTarget) return;
  openAt('blank', event.clientX, event.clientY, null, null);
}

function closeMenu(): void {
  menu.value = null;
}

/**
 * 关菜单：点别处、按 Esc、滚动、改窗口大小都关。
 * 用「点在菜单外就关」而不是铺一层全屏遮罩 —— 贴节点的 popover 压暗背景是多余的，
 * 还会把侧栏盖住一下（用户正要点的那一行）。
 */
function onDocPointerDown(event: PointerEvent): void {
  if (!menu.value) return;
  if (menuEl.value && !menuEl.value.contains(event.target as Node)) closeMenu();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu();
}

watch(menu, (next) => {
  if (next) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
});

/* ------------------------------ 菜单动作 ------------------------------ */

const busy = ref(false);

const createOpen = ref(false);
const createParentId = ref<string | null>(null);
const createName = ref('');

/** 重命名对话框两种目标共用 */
const renameKind = ref<MenuKind>('folder');
const renameTarget = ref<FolderDTO | NoteSummaryDTO | null>(null);
const renameName = ref('');
const renameOpen = ref(false);

const moveKind = ref<MenuKind>('folder');
const moveTarget = ref<FolderDTO | NoteSummaryDTO | null>(null);
const moveOpen = ref(false);

const deleteFolderTarget = ref<FolderDTO | null>(null);
const deleteFolderOpen = ref(false);

const dismissTarget = ref<FolderDTO | null>(null);
const dismissOpen = ref(false);

const deleteNoteTarget = ref<NoteSummaryDTO | null>(null);
const deleteNoteOpen = ref(false);

/** 这一行是不是我正在看的笔记 / 文件夹（删掉 / 搬走后要换页面） */
function isCurrent(target: { id: string }, kind: MenuKind): boolean {
  return kind === 'note' ? target.id === currentNoteId.value : target.id === currentFolderId.value;
}

async function leaveIfCurrent(target: { id: string }, kind: MenuKind): Promise<void> {
  if (isCurrent(target, kind)) await router.push('/');
}

/** 新建笔记：folder 为空 = 建在根目录 */
async function newNote(folder: FolderDTO | null): Promise<void> {
  closeMenu();
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await notesApi.create({ title: '', content: '', folder_id: folder?.id ?? null });
    if (folder) expand(folder.id);
    layout.close();
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}

function openCreateFolder(parent: FolderDTO | null): void {
  closeMenu();
  createParentId.value = parent?.id ?? null;
  createName.value = '';
  createOpen.value = true;
}

function openRename(kind: MenuKind, target: FolderDTO | NoteSummaryDTO): void {
  closeMenu();
  renameKind.value = kind;
  renameTarget.value = target;
  renameName.value = kind === 'folder' ? (target as FolderDTO).name : (target as NoteSummaryDTO).title;
  renameOpen.value = true;
}

function openMove(kind: MenuKind, target: FolderDTO | NoteSummaryDTO): void {
  closeMenu();
  moveKind.value = kind;
  moveTarget.value = target;
  moveOpen.value = true;
}

function openDeleteFolder(folder: FolderDTO): void {
  closeMenu();
  deleteFolderTarget.value = folder;
  deleteFolderOpen.value = true;
}

function openDismiss(folder: FolderDTO): void {
  closeMenu();
  dismissTarget.value = folder;
  dismissOpen.value = true;
}

function openDeleteNote(note: NoteSummaryDTO): void {
  closeMenu();
  deleteNoteTarget.value = note;
  deleteNoteOpen.value = true;
}

/** 「在此导入 / 导入…」：开二选一框，落点就是这一层（空白区 = 根目录） */
const importOpen = ref(false);
const importFolderId = ref<string | null>(null);

function openImport(folder: FolderDTO | null): void {
  closeMenu();
  importFolderId.value = folder?.id ?? null;
  importOpen.value = true;
}

/** 打开笔记：走路由，同时把抽屉收起来（手机上不收起会被遮罩盖住） */
function openNote(note: NoteSummaryDTO): void {
  closeMenu();
  layout.close();
  void router.push(`/notes/${note.id}`);
}

/**
 * 导出单篇为自包含 HTML。与详情页的导出同一套：读正文 → 内嵌图片 → 落盘。
 * 侧栏手上只有标题（列表不带正文），所以这里要再读一次。
 */
async function exportNote(note: NoteSummaryDTO): Promise<void> {
  closeMenu();
  if (busy.value) return;
  busy.value = true;
  try {
    const full = await notesApi.get(note.id);
    const result = await buildExportHtml({
      path: decodeId(note.id),
      title: full.note.title || '无标题笔记',
      content: full.note.content,
    });
    const saved = await saveExportHtml(`${full.note.title || '无标题笔记'}.html`, result.html);
    if (saved === 'canceled') return;
    const miss = result.missed ? `，${result.missed} 张图片没读出来（保留了原引用）` : '';
    ui.toast(`已导出 HTML（内嵌 ${result.inlined} 张图片${miss}）`, 3600);
  } catch (err) {
    ui.toast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', 3600);
  } finally {
    busy.value = false;
  }
}

/**
 * 删除确认里的计数：这一棵子树里有多少子项、其中多少篇笔记。
 * 数据已经在侧栏手上（`folders` / `notes` 都加载过），现算，不再多跑一次遍历。
 */
function subtreeCount(folder: FolderDTO): { total: number; notes: number } {
  const base = decodeId(folder.id);
  const ids = new Set<string>([base]);
  for (const item of folders.value) {
    const path = decodeId(item.id);
    if (path.startsWith(`${base}/`)) ids.add(path);
  }
  const noteCount = notes.value.filter(
    (note) => note.folder_id && ids.has(decodeId(note.folder_id)),
  ).length;
  return { total: ids.size - 1 + noteCount, notes: noteCount };
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
    if (renameKind.value === 'folder') await foldersApi.rename(target.id, name);
    else await notesApi.update(target.id, { title: name });
    renameOpen.value = false;
    ui.toast('已重命名');
    await load();
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '重命名失败');
  } finally {
    busy.value = false;
  }
}

async function submitMove(folderId: string | null): Promise<void> {
  const target = moveTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    if (moveKind.value === 'folder') {
      await foldersApi.move(target.id, folderId);
      await load();
    } else {
      await notesApi.update(target.id, { folder_id: folderId });
      await load();
    }
    moveOpen.value = false;
    ui.toast(folderId ? '已移动' : '已移到未归类');
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '移动失败');
  } finally {
    busy.value = false;
  }
}

/** 删除文件夹：整棵子树作为一个整体进 `.trash`（不是解散） */
async function submitDeleteFolder(): Promise<void> {
  const target = deleteFolderTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await foldersApi.trash(target.id);
    deleteFolderOpen.value = false;
    ui.toast('已移入回收站');
    await load();
    await leaveIfCurrent(target, 'folder');
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

/** 解散：内容上移到上一级，文件夹本身消失（不进回收站） */
async function submitDismiss(): Promise<void> {
  const target = dismissTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await foldersApi.remove(target.id);
    dismissOpen.value = false;
    ui.toast('文件夹已解散，内容已上移到上一级');
    await load();
    await leaveIfCurrent(target, 'folder');
  } catch {
    ui.toast('解散失败');
  } finally {
    busy.value = false;
  }
}

async function submitDeleteNote(): Promise<void> {
  const target = deleteNoteTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await notesApi.remove(target.id);
    deleteNoteOpen.value = false;
    ui.toast('已移入回收站');
    await load();
    await leaveIfCurrent(target, 'note');
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

const deleteCounts = computed(() =>
  deleteFolderTarget.value ? subtreeCount(deleteFolderTarget.value) : { total: 0, notes: 0 },
);
</script>

<template>
  <div class="tree" @contextmenu.prevent="onBlankMenu">
    <p v-if="!rows.length" class="tree-empty">还没有文件夹，右键这里可以新建</p>

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
      @contextmenu.prevent="onRowMenu(row, $event)"
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
            :disabled="busy"
            aria-label="在此文件夹新建笔记"
            @click.stop="newNote(row.folder)"
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
            :aria-haspopup="true"
            @click.stop="onDots('folder', row.folder, $event)"
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
        <span class="tree-fill" />

        <!-- 触屏没有右键：笔记行同样给一个 ⋯ 入口，走同一张动作表 -->
        <span class="tree-actions">
          <button
            class="act"
            type="button"
            aria-label="笔记操作"
            :aria-haspopup="true"
            @click.stop="onDots('note', row.note, $event)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="19" cy="12" r="1.7" fill="currentColor" />
            </svg>
          </button>
        </span>
      </template>
    </div>
  </div>

  <!-- 贴节点的 popover：不铺满屏，所以不压暗背景；点外面 / Esc / 滚动都关 -->
  <Teleport to="body">
    <Transition name="tree-menu">
      <div
        v-if="menu"
        ref="menuEl"
        class="menu glass"
        role="menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      >
        <p class="menu-title">
          <template v-if="menu.kind === 'folder'">📁 {{ menu.folder?.name }}</template>
          <template v-else-if="menu.kind === 'note'">📄 {{ menu.note?.title }}</template>
          <template v-else>我的笔记</template>
        </p>

        <template v-if="menu.kind === 'folder'">
          <button type="button" class="menu-item" :disabled="busy" @click="newNote(menu.folder)">
            新建笔记
          </button>
          <button type="button" class="menu-item" @click="openCreateFolder(menu.folder)">
            新建子文件夹
          </button>
          <button type="button" class="menu-item" @click="openRename('folder', menu.folder!)">
            重命名
          </button>
          <button type="button" class="menu-item" @click="openMove('folder', menu.folder!)">
            移到…
          </button>
          <button type="button" class="menu-item" @click="openImport(menu.folder)">
            在此导入
          </button>
          <button
            type="button"
            class="menu-item is-danger"
            @click="openDeleteFolder(menu.folder!)"
          >
            删除…
          </button>
          <button type="button" class="menu-item" @click="openDismiss(menu.folder!)">
            解散（内容上移）
          </button>
        </template>

        <template v-else-if="menu.kind === 'note'">
          <button type="button" class="menu-item" @click="openNote(menu.note!)">打开</button>
          <button type="button" class="menu-item" @click="openRename('note', menu.note!)">
            重命名
          </button>
          <button type="button" class="menu-item" @click="openMove('note', menu.note!)">
            移到…
          </button>
          <button type="button" class="menu-item" @click="exportNote(menu.note!)">
            导出 HTML
          </button>
          <button
            type="button"
            class="menu-item is-danger"
            @click="openDeleteNote(menu.note!)"
          >
            删除…
          </button>
        </template>

        <template v-else>
          <button type="button" class="menu-item" :disabled="busy" @click="newNote(null)">
            新建笔记
          </button>
          <button type="button" class="menu-item" @click="openCreateFolder(null)">
            新建文件夹
          </button>
          <button type="button" class="menu-item" @click="openImport(null)">导入…</button>
        </template>
      </div>
    </Transition>
  </Teleport>

  <AppDialog
    :open="createOpen"
    :title="createParentId ? '新建子文件夹' : '新建文件夹'"
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

  <MoveDialog
    :open="moveOpen"
    :busy="busy"
    :exclude-ids="moveKind === 'folder' && moveTarget ? [moveTarget.id] : []"
    @close="moveOpen = false"
    @pick="submitMove"
  />

  <ImportDialog
    :open="importOpen"
    :folder-id="importFolderId"
    @close="importOpen = false"
    @done="load"
  />

  <AppDialog
    :open="deleteFolderOpen"
    title="删除这个文件夹？"
    confirm-label="移入回收站"
    danger
    :busy="busy"
    @close="deleteFolderOpen = false"
    @confirm="submitDeleteFolder"
  >
    <p class="menu-tip">
      将删除 {{ deleteCounts.total }} 个子项（含 {{ deleteCounts.notes }} 篇笔记），
      整棵子树一起进入回收站，30 天内可恢复。
    </p>
  </AppDialog>

  <AppDialog
    :open="dismissOpen"
    title="解散这个文件夹？"
    confirm-label="解散"
    danger
    :busy="busy"
    @close="dismissOpen = false"
    @confirm="submitDismiss"
  >
    <p class="menu-tip">
      解散后内容会上移到上一级，文件夹消失。确定？（内容不会删除）
    </p>
  </AppDialog>

  <AppDialog
    :open="deleteNoteOpen"
    title="删除这篇笔记？"
    confirm-label="移入回收站"
    danger
    :busy="busy"
    @close="deleteNoteOpen = false"
    @confirm="submitDeleteNote"
  >
    <p class="menu-tip">笔记将进入回收站，30 天内可恢复。确定？</p>
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

/* ------------------------------ 贴节点的菜单 ------------------------------ */

/*
 * z-index 21：压在侧栏（20）与移动端遮罩（19）之上，又在 AppDialog（22）之下。
 * 尺寸固定（与脚本里的 MENU_W / MENU_H 对应）—— 贴边翻页要的是确定值，不能是 auto。
 */
.menu {
  position: fixed;
  z-index: 21;
  width: 208px;
  max-height: 336px;
  overflow-y: auto;
  padding: var(--sp-1);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-title {
  padding: 6px var(--sp-1) 4px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-item {
  height: 34px;
  padding: 0 var(--sp-1);
  border-radius: var(--r-xs);
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease-smooth);
}

.menu-item:hover:not(:disabled) {
  background: var(--surface);
}

.menu-item:disabled {
  opacity: 0.5;
}

.menu-item.is-danger {
  color: var(--danger);
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

/* 入场与规范统一：300ms 弹簧曲线（原来只有 opacity，跟其它浮层对不上） */
.tree-menu-enter-active,
.tree-menu-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    transform var(--dur) var(--ease-spring);
}

.tree-menu-enter-from,
.tree-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
