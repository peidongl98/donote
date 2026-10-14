<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { FolderDTO, NoteDTO } from '@donote/shared';
import { DavError, decodeId, foldersApi, notesApi } from '@/storage/notes';
import { uploadAttachment } from '@/services/attachments';
import { pickImage } from '@/services/pick-image';
import { useEditingStore } from '@/stores/editing';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import NoteEditor from '@/components/editor/NoteEditor.vue';
import { EMPTY_SNAPSHOT, redo, undo } from '@/components/editor/commands';
import { buildExportHtml, saveExportHtml } from '@/services/export-html';

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const editing = useEditingStore();

/** 标题即文件名，改名会换 id，所以这里必须是响应式的 */
const noteId = ref(String(route.params.id));
const note = ref<NoteDTO | null>(null);
const title = ref('');
const content = ref('');
const status = ref<SaveStatus>('idle');
const loading = ref(true);

/** 所见即所得 / 源码。默认所见即所得，开关在顶栏右侧 */
const mode = ref<'wysiwyg' | 'source'>('wysiwyg');

/**
 * 「切回所见即所得会规范化格式」这句话只提醒一次。
 * 存的是「别再问了」这个状态，不是问没问过 —— 用户清掉浏览器数据就再提醒一次，符合预期。
 */
const HINT_KEY = 'donote.normalize-hint';
const askWysiwyg = ref(false);
const muteHint = ref(false);

function toggleMode(): void {
  if (mode.value === 'wysiwyg') {
    mode.value = 'source';
    return;
  }
  // 切回去要把正文重新过一遍 Milkdown 的解析 → 序列化，写法会被统一（渲染不变）。
  // 这件事说一次就够，勾了「不再提示」就不再拦。
  if (localStorage.getItem(HINT_KEY) === 'off') {
    mode.value = 'wysiwyg';
    return;
  }
  muteHint.value = false;
  askWysiwyg.value = true;
}

function backToWysiwyg(): void {
  if (muteHint.value) localStorage.setItem(HINT_KEY, 'off');
  askWysiwyg.value = false;
  mode.value = 'wysiwyg';
}

/**
 * 「这篇笔记被重新读进来了」的代次，作编辑器的 key。
 *
 * NoteEditor 有意不监听 modelValue（只有一个真相来源），换笔记只能重建组件。
 * 但**改名不是换笔记**：拿 noteId 当 key 的话，标题一改、路由一换，编辑器就被拆掉重建，
 * 光标连同「下次插图落哪」一起丢了。所以 key 挂加载代次，改名时纹丝不动。
 */
const loadSeq = ref(0);

const folders = ref<FolderDTO[]>([]);
const sheetOpen = ref(false);
const moveOpen = ref(false);
const deleteOpen = ref(false);
const hardDeleteOpen = ref(false);
const busy = ref(false);

/** 正文编辑器实例，用来在光标处插图 */
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null);
/** 编辑器快照（撤销 / 重做按钮的可用状态）。源码模式下编辑器不存在，会退回全禁用 */
const editorState = computed(() => editorRef.value?.state ?? EMPTY_SNAPSHOT);
const editor = computed(() => editorRef.value?.getEditor() ?? null);
/** 插图失败时的内联提示（不弹层，就地说明为什么没插进去） */
const imageError = ref('');
let picking = false;

/**
 * 点工具栏「图片」→ 选文件 → 存进这篇笔记的附件目录 → 在当前光标处插入引用。
 *
 * 路径规则一条都不新增：存哪儿由 uploadAttachment 按 getAssetsDirPath 推，
 * 写进正文的相对路径也由它给。这里只负责把三件事串起来。
 */
async function pickAndInsertImage(): Promise<void> {
  if (picking) return;
  picking = true;
  imageError.value = '';
  try {
    const picked = await pickImage();
    if (!picked) return; // 用户取消，什么都不做

    // 选完文件再等一次自动保存：标题刚改过的话，这一步跑完 noteId 才指向新文件名
    await flush();

    // 标题即文件名，改名那次保存已经把 noteId 换成新路径，这里直接解
    const { url } = await uploadAttachment(decodeId(noteId.value), picked.name, picked.data);
    // 等它上报完再返回：正文一到手就会排进保存队列，用户紧接着离开也不会丢图
    await editorRef.value?.placeImage(url, picked.name.replace(/\.[^.]+$/, '') || '图片');
  } catch (err) {
    imageError.value = err instanceof Error ? `图片没插进去：${err.message}` : '图片没插进去';
  } finally {
    picking = false;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let pending = false;
/** 保存彻底停下来时要通知的人（等待点见 flush） */
let idleWaiters: Array<() => void> = [];

/** 队列空了：要么接着写排队的那一次，要么把等着的人放行 */
function settleIdle(): void {
  saving = false;
  if (pending) {
    pending = false;
    void save();
    return;
  }
  for (const done of idleWaiters) done();
  idleWaiters = [];
}

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
    loadSeq.value += 1;
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
    settleIdle();
  }
}

function scheduleSave(): void {
  status.value = 'dirty';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 1200);
}

/**
 * 立刻把待保存的改动写完，并等到真正落盘。
 *
 * 插图前必须先走这一步：标题是防抖自动保存的，改过名的话 noteId 要等保存回来才换成新路径。
 * 不等的后果是附件被存进旧名字的 .assets 目录，而链接写进正文之后改名那次保存已经过去了，
 * 不会再被改写 —— 图就裂了。
 */
async function flush(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (isTrashed.value || (!saving && status.value !== 'dirty')) return;
  const done = new Promise<void>((resolve) => idleWaiters.push(resolve));
  if (!saving) void save();
  await done;
}

/* --------------------------- 标签 --------------------------- */

/**
 * 标签只落在 frontmatter 的 `tags: [...]` 上 —— 直接 `notesApi.update(id, { tags })`，
 * 它内部是「读回原文件 → 用同一份 body 重新序列化」，所以正文与其它字段一个字节不动。
 * 不碰正文结构，也不引入第二条写文件的路径。
 */
const tags = ref<string[]>([]);
const tagDraft = ref('');

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim();
}

async function saveTags(next: string[]): Promise<void> {
  const unique = [...new Set(next.map(normalizeTag).filter(Boolean))].slice(0, 20);
  try {
    const res = await notesApi.update(noteId.value, { tags: unique });
    tags.value = res.note.tags;
    ui.toast('标签已更新');
  } catch {
    ui.toast('标签没保存上');
  }
}

function addTag(): void {
  const tag = normalizeTag(tagDraft.value);
  tagDraft.value = '';
  if (!tag || tags.value.includes(tag)) return;
  void saveTags([...tags.value, tag]);
}

function removeTag(tag: string): void {
  void saveTags(tags.value.filter((item) => item !== tag));
}

/* --------------------------- 导出 --------------------------- */

const exporting = ref(false);

/**
 * 导出这篇笔记为自包含 HTML。
 *
 * 导出前先 flush：标题/正文还在防抖窗口里的话，导出的会是上一次的内容。
 */
async function exportHtml(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    await flush();
    const result = await buildExportHtml({
      path: decodeId(noteId.value),
      title: title.value.trim() || '无标题笔记',
      content: content.value,
    });
    const saved = await saveExportHtml(`${title.value.trim() || '无标题笔记'}.html`, result.html);
    if (saved === 'canceled') return;
    const miss = result.missed ? `，${result.missed} 张图片没读出来（保留了原引用）` : '';
    ui.toast(`已导出 HTML（内嵌 ${result.inlined} 张图片${miss}）`, 3600);
  } catch (err) {
    ui.toast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', 3600);
  } finally {
    exporting.value = false;
    sheetOpen.value = false;
  }
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

// 标记「这篇笔记正开着」，列表 / 文件夹 / 回收站的动作菜单据此禁用重命名 / 移动 / 删除。
// 标题改了会换 id，所以跟着 noteId 走而不是只在挂载时标一次。
watch(noteId, (id) => editing.enter(id), { immediate: true });
onBeforeUnmount(() => {
  editing.leave(noteId.value);
  void flush();
});
</script>

<template>
  <div class="editor">
    <AppHeader :title="isTrashed ? '回收站中的笔记' : '编辑'" :subtitle="folderName" back>
      <template #actions>
        <span class="status mono" :class="`is-${status}`">{{ statusText }}</span>
        <button
          class="icon-btn"
          type="button"
          aria-label="撤销"
          title="撤销 (Ctrl+Z)"
          :disabled="!editorState.canUndo"
          @mousedown.prevent
          @click="undo(editor)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="重做"
          title="重做 (Ctrl+Y)"
          :disabled="!editorState.canRedo"
          @mousedown.prevent
          @click="redo(editor)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </button>
        <button
          class="icon-btn"
          type="button"
          :aria-label="mode === 'wysiwyg' ? '源码' : '所见即所得'"
          :title="mode === 'wysiwyg' ? '切到源码模式' : '切回所见即所得模式'"
          :disabled="loading"
          @click="toggleMode"
        >
          <!-- 切到源码：一对尖括号；切回来：一只眼睛 -->
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
            stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <template v-if="mode === 'wysiwyg'">
              <path d="M9.5 7 4.5 12l5 5M14.5 7l5 5-5 5" />
            </template>
            <template v-else>
              <path d="M2.5 12S6 6.2 12 6.2 21.5 12 21.5 12 18 17.8 12 17.8 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="2.6" />
            </template>
          </svg>
        </button>
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

      <!-- 标签：只改 frontmatter 的 tags，正文一个字节不动 -->
      <div class="tag-bar">
        <span v-for="tag in tags" :key="tag" class="tag-chip">
          #{{ tag }}
          <button type="button" :aria-label="`移除标签 ${tag}`" @click="removeTag(tag)">×</button>
        </span>
        <input
          v-model="tagDraft"
          class="tag-input"
          type="text"
          placeholder="加标签，回车"
          aria-label="添加标签"
          :disabled="loading || isTrashed"
          @keydown.enter.prevent="addTag"
          @keydown.esc.prevent="tagDraft = ''"
        />
      </div>

      <div v-if="loading" class="skeleton" />

      <template v-else>
        <p v-if="imageError" class="inline-note is-error">{{ imageError }}</p>

        <NoteEditor
          ref="editorRef"
          :key="loadSeq"
          v-model="content"
          :mode="mode"
          :readonly="isTrashed"
          @save="scheduleSave"
          @pick-image="pickAndInsertImage"
        />
      </template>
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
              type="button"
              class="sheet-item"
              :disabled="isTrashed || loading || exporting"
              @click="exportHtml"
            >
              {{ exporting ? '导出中…' : '导出 HTML' }}
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
          📁 {{ f.name }}
        </button>
      </div>
    </AppDialog>

    <!-- 插入图片：走系统文件对话框，图片存进这篇笔记自己的附件目录 -->
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
      <p class="tip">这一步不可恢复，文件会被从你的网盘里真正删掉。</p>
    </AppDialog>

    <!-- 切回所见即所得前的提醒：源码里怎么写都行，回程会被统一规范化 -->
    <AppDialog
      :open="askWysiwyg"
      title="切回所见即所得？"
      confirm-label="继续"
      @close="askWysiwyg = false"
      @confirm="backToWysiwyg"
    >
      <p class="tip">切回所见即所得模式，格式会被统一规范化。是否继续？</p>
      <label class="check">
        <input v-model="muteHint" type="checkbox" />
        <span>不再提示</span>
      </label>
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
  /* 桌面端给侧边栏让位；移动端 --content-offset 恒为 0 */
  padding-left: var(--content-offset);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transition: padding-left var(--dur) var(--ease-smooth);
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

/* 顶栏上的模式开关：图标按钮，两种模式共用一个位置 */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  flex: none;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.icon-btn:hover:not(:disabled) {
  background: var(--surface);
  color: var(--text);
}

.icon-btn:disabled {
  opacity: 0.45;
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
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--sp-3) var(--page-gutter);
  gap: var(--sp-2);
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

/* 插图失败时的内联提示：就地说明，不弹层 */
.inline-note {
  padding: 8px 12px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}

.inline-note.is-error {
  color: var(--danger);
  background: var(--danger-soft);
}

/* 「不再提示」勾选：整行可点，别只点那个小方块 */
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: var(--sp-2);
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}

.check input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
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

/* .folder-list / .folder-pick 与底部弹层的样式都在 styles/app.css（全局一份，多处共用） */
.folder-pick.is-on {
  color: var(--accent);
  border-color: var(--accent-ring);
}


.tag-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--sp-1);
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px 0 9px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  color: var(--accent);
  background: var(--accent-soft);
}

.tag-chip button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--r-pill);
  font-size: 13px;
  line-height: 1;
  color: inherit;
}

.tag-chip button:hover {
  background: var(--surface);
}

.tag-input {
  width: 132px;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--r-xs);
  font-size: var(--fs-xs);
  color: var(--text);
  background: transparent;
  border: 1px dashed var(--surface-border);
}

.tag-input:focus {
  border-style: solid;
  border-color: var(--accent-ring);
}
</style>
