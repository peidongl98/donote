<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { FolderDTO, NoteDTO } from '@donote/shared';
import { DavError, containerDirOf, decodeId, encodeId, foldersApi, notesApi, pageDirOf } from '@/storage/notes';
import { uploadAttachment } from '@/services/attachments';
import { pickImage } from '@/services/pick-image';
import { useEditingStore } from '@/stores/editing';
import { useUiStore } from '@/stores/ui';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import NoteEditor from '@/components/editor/NoteEditor.vue';
import { EMPTY_SNAPSHOT, redo, undo } from '@/components/editor/commands';
import { clampDocWidth } from '@/components/editor/doc-width';
import { buildExportHtml, saveExportHtml } from '@/services/export-html';
import { suggestTags } from '@/utils/suggest-tags';

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

/** 顶栏面包屑。用局部类型是因为 `*.vue` 只声明了 default 导出，拿不到 AppHeader 里的 Crumb */
interface Crumb {
  label: string;
  to?: string;
}

/** 路径逐级累积：'a/b/c' → ['a', 'a/b'] */
function pathChain(rel: string): string[] {
  const segments = rel.split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment;
    out.push(acc);
  }
  return out;
}

/**
 * 层级面包屑：`框架笔记 / 子笔记B / 当前页`。
 *
 * 页面（目录 + index.md）→ 链到那篇笔记；纯文件夹 → 链到文件夹详情；最后一段是当前这篇，
 * 不可点。回收站里的笔记没有层级可言，返回空数组让顶栏退回「回收站中的笔记」标题形态。
 */
const crumbs = computed<Crumb[]>(() => {
  if (isTrashed.value || loading.value) return [];
  const rel = decodeId(noteId.value);
  const pageDir = pageDirOf(rel);
  // 祖先链：页面的「所在目录」就是它自己，要去掉末段才是祖先；普通笔记去掉文件名即可。
  const ancestorDir =
    pageDir === null
      ? rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
      : pageDir.slice(0, Math.max(0, pageDir.lastIndexOf('/')));
  const dirs = pathChain(ancestorDir);

  const out: Crumb[] = dirs.map((dirPath) => {
    const folder = folders.value.find((item) => decodeId(item.id) === dirPath);
    const label = folder?.name ?? dirPath.slice(dirPath.lastIndexOf('/') + 1);
    if (folder?.page_id) return { label, to: `/notes/${folder.page_id}` };
    return folder ? { label, to: `/folders/${folder.id}` } : { label };
  });

  const last =
    pageDir === null
      ? title.value.trim() || '无标题笔记'
      : pageDir.slice(pageDir.lastIndexOf('/') + 1);
  out.push({ label: last });
  return out;
});

/*
 * 「子页面」列表已经不放在正文下方了 —— 层级看侧栏树就够（Notion 也是靠侧栏看层级），
 * 正文外再列一份只是重复。「新建子页面」按钮搬进了顶栏 ⋯ 菜单，实现见 addChildPage。
 */

/**
 * 文件夹列表：面包屑的每一段靠它判「这一段是页面还是纯文件夹」，所以它必须跟着当前笔记刷新 ——
 * 只在挂载时取一次的话，**换一篇笔记之后新建的那几层在列表里根本不存在**，
 * 面包屑会退化成不可点的纯文字（看起来像「点了没反应」）。
 */
async function loadFolders(): Promise<void> {
  try {
    folders.value = (await foldersApi.list()).items;
  } catch {
    // 拉取失败只影响「移动」弹窗与面包屑，不阻塞编辑
  }
}

/** 新建子页面：页面 → 它自己的目录；普通笔记 → 它所在的目录 */
async function addChildPage(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await flush(); // 先把自己落盘，别让刚打的字跟着丢
    const res = await notesApi.createPage({ parent_dir: containerDirOf(decodeId(noteId.value)) });
    await loadFolders(); // 新目录要进列表，面包屑下一层才认得出它
    ui.toast('已创建子页面');
    await router.push(`/notes/${res.note.id}`);
  } catch {
    ui.toast('新建子页面失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}

/* --------------------------- 笔记链接 [[…]] --------------------------- */

/**
 * 笔记名 → 笔记 id。`[[…]]` 的着色、补全候选、点击跳转全靠它。
 * 从同一次目录遍历里算（不多发请求），所以每次进详情页重取一次即可。
 */
const titleIndex = ref<Record<string, string>>({});

async function loadTitleIndex(): Promise<void> {
  try {
    titleIndex.value = await notesApi.titleIndex();
  } catch {
    titleIndex.value = {};
  }
}

/**
 * 「反向链接」：谁的正文里提到了这篇的标题。
 *
 * 出链是补摘要时顺手记进摘要缓存的，所以这里只是把缓存补齐再派生 ——
 * 不额外读正文、不落第二个索引文件。缓存热的时候一次就返回（不耗请求）。
 */
const backlinks = ref<Array<{ id: string; title: string }>>([]);
/** 「N 篇笔记提到这里」默认收起：它是次要信息，不该一直占着一行行高 */
const backlinksOpen = ref(false);

async function loadBacklinks(): Promise<void> {
  // 用**已落盘**的标题查：反链是按名字索引的，拿正在输入中的半截标题去查必然查不到
  const name = note.value?.title?.trim() ?? '';
  if (isTrashed.value || !name) {
    backlinks.value = [];
    return;
  }
  try {
    backlinks.value = await notesApi.backlinks(name);
  } catch {
    backlinks.value = [];
  }
}

/**
 * 确保名字对应的笔记存在，返回它的 id。
 *
 * 两个入口共用：补全菜单里的「创建『X』」、点开一条红色的 `[[…]]`。
 * 新笔记建在**这篇所在的目录**，跟它摆在一起，而不是丢到根上。
 */
async function ensureNote(name: string): Promise<string | null> {
  const existing = titleIndex.value[name];
  if (existing) return existing;
  const dir = containerDirOf(decodeId(noteId.value));
  try {
    const res = await notesApi.create({ title: name, folder_id: dir ? encodeId(dir) : null });
    await loadTitleIndex(); // 立刻重建索引，让正文里那条链接当场变蓝
    ui.toast(`已创建「${name}」`);
    return res.note.id;
  } catch {
    ui.toast('创建失败，请稍后重试');
    return null;
  }
}

async function openWikilink(name: string, exists: boolean): Promise<void> {
  // 换笔记时落盘由路由 watcher 负责（这里不重复一次）
  const id = exists ? (titleIndex.value[name] ?? null) : await ensureNote(name);
  if (id) await router.push(`/notes/${id}`);
}

const statusText = computed(() => {
  switch (status.value) {
    case 'dirty':
      return '编辑中';
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
    // 标签挂在 frontmatter 上，打开笔记时得一起读出来。
    // 少了这一句的话，已有标签的笔记打开后标签栏是空的（只有当场加/删标签才会显示）。
    tags.value = res.note.tags;
    imageError.value = '';
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

/**
 * 建议标签：正文里词频最高的几个词，**虚线框**摆在标签栏里。
 *
 * 只是建议 —— 点一下才写进 frontmatter 的 tags，不点就什么都不发生（正文与 tags 都不动）。
 * 采纳过的不再出现；标题本身也排除（标题已经写在最上面了，再当标签是重复）。
 */
const suggestedTags = computed(() => {
  const own = title.value.trim();
  return suggestTags(content.value).filter((word) => word !== own && !tags.value.includes(word));
});

/** 采纳一条建议：走的是和手打标签完全同一条路（saveTags → notesApi.update 只改 tags） */
function addSuggestedTag(word: string): void {
  if (tags.value.includes(word)) return;
  void saveTags([...tags.value, word]);
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
  } catch (err) {
    // 带上原因：撞限流（503）与「代码坏了」对用户是两件事，只说「删除失败」等于没说
    ui.toast(err instanceof DavError ? err.message : '删除失败');
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
  window.addEventListener('keydown', syncModifier);
  window.addEventListener('keyup', syncModifier);
  // Alt+Tab 切走时收不到 keyup，回来会一直留着「按住」的状态
  window.addEventListener('blur', onWindowBlur);
  // 缩放窗口 → 正文框回默认宽度（见 resetDocWidthOnResize）
  window.addEventListener('resize', resetDocWidthOnResize);
  await load();
  await loadTitleIndex();
  await loadFolders();
});

/**
 * 换笔记 / 改名之后要跟着重取的东西。
 *
 * 🔴 只放在 `watch(noteId)` 里是不够的：**此刻 title 还是上一篇的**（`load()` 在路由 watcher 里
 * 晚一步才跑），反链按名字查，用错名字等于查不到。所以：
 *   · 依赖 id 的（索引、文件夹列表）跟着 noteId 走；
 *   · 依赖标题的（反链）跟着**已落盘的标题**走 —— 它由 load() / save() 写进 `note`，
 *     换笔记与改名两条路都覆盖到，也不会因为打字而重跑。
 */
watch(noteId, () => {
  void loadTitleIndex();
  void loadFolders();
});

watch(
  () => note.value?.title ?? '',
  () => void loadBacklinks(),
);

// 标记「这篇笔记正开着」，列表 / 文件夹 / 回收站的动作菜单据此禁用重命名 / 移动 / 删除。
// 标题改了会换 id，所以跟着 noteId 走而不是只在挂载时标一次。
watch(noteId, (id) => editing.enter(id), { immediate: true });

/**
 * 换笔记：路由 param 由 A 变成 B 时，**组件是被复用的**（/notes/:id 是同一条路由记录），
 * 不监听的话画面纹丝不动 —— 只有地址栏变了，返回键还得按两次才回得到列表。
 *
 * 为什么用「param ≠ noteId」而不是直接 watch(noteId)：改名也会换 id，
 * 但它走的是 router.replace 且**先**更新 noteId，那时两者已经相等，正好被排除掉；
 * 加载失败跳回首页时 route.name 不再叫 note，也不该再触发一次加载。
 */
watch(
  () => (route.name === 'note' ? String(route.params.id) : ''),
  async (id) => {
    if (!id || id === noteId.value) return;
    await flush(); // 上一篇还没写完的先落盘，否则那些字会跟着丢
    noteId.value = id;
    note.value = null;
    await load();
  },
);
/* ------------------------------ 正文框宽度 ------------------------------ */

/**
 * 按住 Ctrl / Cmd 时，正文框两侧的宽度手柄才醒过来。
 *
 * 平时手柄不接指针事件（`.width-grip` 是 pointer-events: none）—— 那 6 像素里就是
 * 正文本身，挡住就点不着光标了。唤醒的代价只是正文框两侧各一条细线（由 NoteEditor 的
 * .surface-slot 画，贴着框的上下沿），同时也是「可以拖了」的提示。
 */
const ctrlDown = ref(false);

/** 只在有精细指针（鼠标）的设备上给手柄；手机（触摸）不接这条逻辑 */
const mouseDevice = typeof window === 'undefined' || window.matchMedia('(pointer: fine)').matches;

function syncModifier(e: KeyboardEvent): void {
  ctrlDown.value = e.ctrlKey || e.metaKey;
}

function onWindowBlur(): void {
  ctrlDown.value = false;
}

/** 当前框宽，px；null = 默认（内容区满宽） */
const docWidth = ref<number | null>(null);

/**
 * 窗口一缩放就回默认宽度。
 *
 * 这一条同时替掉了「记住上次拖到多宽」：宽度只活在内存里，不落盘、不跨窗口，
 * 于是不需要按比例存、不需要在换显示器后重算 —— 一个变量加一个监听就够了。
 */
function resetDocWidthOnResize(): void {
  docWidth.value = null;
}

/** 内容区可用宽：正文框 100% 时有多宽 = 父级内容盒宽去掉左右内边距 */
function availableWidth(bodyEl: HTMLElement): number {
  const parent = bodyEl.parentElement as HTMLElement;
  const cs = getComputedStyle(parent);
  return parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

/**
 * 拖正文框的左或右任一条边，改的是同一个宽度。
 *
 * 框是居中的，所以指针走 dx、两侧各让出 dx —— 宽度变 2dx（左右方向相反，见 dir）。
 * 始终拿**按下时那一帧**的宽度加总位移来算，不逐帧累加：否则夹到上下限之后，
 * 虚拟位移和真实宽度就分道扬镳，松手再按会跳一下（jQuery UI resizable 的老毛病）。
 * 上下限见 doc-width.ts：下限写死 544px，上限是当前的可用宽。
 */
function startWidthResize(e: PointerEvent): void {
  if (e.button !== 0 || !ctrlDown.value) return;
  // 不吃掉默认行为的话，指针一拖到正文上就会被当成「拖选文字」，
  // Chromium 会发一个 dragstart 掐断整个指针序列（侧栏拖拽踩过同一个坑）
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const dir = handle.classList.contains('is-left') ? -1 : 1;
  const bodyEl = handle.parentElement as HTMLElement;
  const available = availableWidth(bodyEl);
  const startW = Math.min(docWidth.value ?? available, available);
  const startX = e.clientX;

  // 拖拽期间挂上全局拖拽态（styles/tokens.css 的 html[data-resizing]）：
  // 光标统一变左右箭头、压住文本选中，跟拖侧边栏是同一套
  const root = document.documentElement;
  root.setAttribute('data-resizing', '1');
  handle.setPointerCapture(e.pointerId);

  const move = (ev: PointerEvent): void => {
    docWidth.value = clampDocWidth(startW + dir * 2 * (ev.clientX - startX), available);
  };
  const finish = (): void => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    root.removeAttribute('data-resizing');
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', syncModifier);
  window.removeEventListener('keyup', syncModifier);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', resetDocWidthOnResize);
  editing.leave(noteId.value);
  void flush();
});
</script>

<template>
  <div class="editor">
    <!--
      顶栏左边是**层级面包屑**（框架笔记 / 子笔记B / 当前页），每段可点、末段是当前这篇。
      不放「编辑」这种没有信息量的词，也不放「编辑中 / 已保存」这类状态字：保存是自动的，
      一直挂个字反而吵。保存状态只留给屏幕阅读器播报（视觉上隐藏），保存失败另外走 toast。
    -->
    <AppHeader :title="isTrashed ? '回收站中的笔记' : ''" :crumbs="crumbs" back>
      <template #actions>
        <span class="sr-only status" role="status" aria-live="polite">{{ statusText }}</span>
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

    <div
      class="body"
      :class="{ 'is-resizable': ctrlDown }"
      :style="docWidth === null ? undefined : { width: `${docWidth}px` }"
    >
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

        <!-- 建议标签：虚线框 = 还没采纳。点一下才写进 frontmatter，不点则什么都不发生 -->
        <template v-if="!isTrashed && !loading && suggestedTags.length">
          <span class="tag-suggest-divider" aria-hidden="true" />
          <button
            v-for="word in suggestedTags"
            :key="word"
            type="button"
            class="tag-suggest"
            :title="`把「${word}」加为标签`"
            @click="addSuggestedTag(word)"
          >
            + {{ word }}
          </button>
        </template>
      </div>

      <div v-if="loading" class="skeleton" />

      <template v-else>
        <!--
          反向链接：谁的正文里写了 [[这篇的标题]]。
          一行、默认收起；一条都没有时整行不渲染（Notion 也是这样）。放在正文顶部。
        -->
        <div v-if="backlinks.length" class="backlink-bar">
          <button
            type="button"
            class="backlink-toggle"
            :aria-expanded="backlinksOpen"
            @click="backlinksOpen = !backlinksOpen"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              aria-hidden="true"
              :class="{ 'is-open': backlinksOpen }"
            >
              <path
                d="m9 6 6 6-6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {{ backlinks.length }} 篇笔记提到这里
          </button>
          <ul v-if="backlinksOpen" class="backlink-list">
            <li v-for="link in backlinks" :key="link.id">
              <button
                type="button"
                class="backlink-item"
                @click="router.push(`/notes/${link.id}`)"
              >
                {{ link.title }}
              </button>
            </li>
          </ul>
        </div>

        <p v-if="imageError" class="inline-note is-error">{{ imageError }}</p>

        <NoteEditor
          ref="editorRef"
          :key="loadSeq"
          v-model="content"
          :mode="mode"
          :readonly="isTrashed"
          :title-index="titleIndex"
          @save="scheduleSave"
          @pick-image="pickAndInsertImage"
          @open-wikilink="openWikilink"
          @create-note="ensureNote"
        />
      </template>

      <!--
        宽度手柄：骑在正文框的左右边界上（各 3px 在外、3px 在内），平时不可见、不吃指针，
        按住 Ctrl 才亮出细线（见 .body.is-resizable）。手机端不给 —— 见 doc-width.ts 开头。
      -->
      <template v-if="mouseDevice">
        <div
          class="width-grip is-left"
          aria-hidden="true"
          @pointerdown="startWidthResize"
          @dblclick="docWidth = null"
        />
        <div
          class="width-grip is-right"
          aria-hidden="true"
          @pointerdown="startWidthResize"
          @dblclick="docWidth = null"
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
              :disabled="isTrashed || loading || busy"
              @click="sheetOpen = false; addChildPage()"
            >
              新建子页面
            </button>
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
  /*
   * 编辑页内容列宽：填满内容区，不设上限。
   *
   * 用 100%（相对内容区，已扣 --content-offset）而不是 88vw（相对视口）：
   * 侧栏宽度是用户拖出来的，视口百分比不会跟着变 —— 拖宽侧栏时列宽该跟着缩。
   *
   * 一行多长由字号决定（默认 16px，工具栏可调），不靠收窄列宽来凑：
   * 收窄是拿两侧留白换的，1500 视口下会把正文挤成中间一条。
   * 两侧的呼吸距离交给 .body 的左右 padding，不用列宽上限去做。
   */
  --content-max: 100%;
  /* 桌面端给侧边栏让位；移动端 --content-offset 恒为 0 */
  padding-left: var(--content-offset);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  transition: padding-left var(--follow-dur) var(--ease-smooth);
}

/* ------------------------------ 反向链接 ------------------------------ */

/*
 * 一行、贴着正文顶部。默认收起，点一下才展开明细。
 * 一条都没有时整个 .backlink-bar 不渲染（v-if），所以这里的间距不会孤零零地剩着。
 */
.backlink-bar {
  /* 与下方正文的间距由 .body 的 flex gap 给，不重复加 margin */
  font-size: var(--fs-xs);
}

.backlink-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 4px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.backlink-toggle:hover {
  background: var(--surface);
  color: var(--text);
}

/* 箭头：收起时朝右，展开后转 90° 朝下 */
.backlink-toggle svg {
  flex: none;
  transition: transform var(--dur-fast) var(--ease-smooth);
}

.backlink-toggle svg.is-open {
  transform: rotate(90deg);
}

.backlink-list {
  display: grid;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0 0 0 22px;
  list-style: none;
}

.backlink-item {
  display: block;
  width: 100%;
  padding: 3px 8px;
  border-radius: var(--r-xs);
  color: var(--text-2);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.backlink-item:hover {
  background: var(--surface);
  color: var(--text);
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
  /*
   * 左右比全局留白（--page-gutter = sp-3 = 24）多一档：正文列填满之后，
   * 容器边框离侧栏 / 屏幕边就只剩左右 padding 这点距离，24 太贴。
   * 上下不跟着加 —— 那是把正文推离工具栏，与「不贴边」无关。
   *
   * 提成变量是因为宽度手柄要按它骑到正文框的边界上；拖窄之后正文框（.donote-surface）
   * 与标题、工具栏一起跟着这个容器走，四层边界始终对齐。
   */
  --body-pad-x: var(--sp-4);
  padding: var(--sp-3) var(--body-pad-x);
  gap: var(--sp-2);
  /* 手柄的定位基准。宽度由 JS 写在元素上（拖过才有，见 docWidth） */
  position: relative;
  /* 默认宽度（不设 inline style 时）。flex 项默认 min-width: auto 撑在内容宽上，
     不归零的话长代码行会把拖窄的框重新顶开 */
  min-width: 0;
}

/*
 * 正文框宽度手柄。平时是一条 6px 的透明带，既不显示也不吃指针 ——
 * 那几像素里就是正文，挡住就点不着光标了；按住 Ctrl 才醒来（.is-resizable）。
 * touch-action 关掉是防触屏把手势判成滚动，pointermove 会直接断掉（与侧边栏手柄同一处坑）。
 */
.width-grip {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  pointer-events: none;
  touch-action: none;
  z-index: 2;
}

/* 骑在正文框的左右边界上：带子跨边界内外各 3px，命中区正好落在框边上 */
.width-grip.is-left {
  left: calc(var(--body-pad-x) - 3px);
}

.width-grip.is-right {
  right: calc(var(--body-pad-x) - 3px);
}

.body.is-resizable .width-grip {
  pointer-events: auto;
  cursor: col-resize;
}

/*
 * 「可以拖」的提示线由正文框那层画（NoteEditor 的 .surface-slot::before/::after），
 * 因为线要正好贴着正文框，不能从标题一路贯下来 —— 手柄这一层只有命中区，本身不着色。
 */
.body.is-resizable {
  --grip-line: 1;
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

/*
 * 建议标签。与输入框的灰虚线区分开：这里用强调色的虚线 + 前缀「+」，
 * 「可点、点了才生效」一眼看得出来。悬停变实线 = 即将采纳。
 */
.tag-suggest-divider {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--divider);
}

.tag-suggest {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px dashed var(--accent-ring);
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  color: var(--text-2);
  transition:
    color var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth),
    border-color var(--dur-fast) var(--ease-smooth);
}

.tag-suggest:hover {
  color: var(--accent);
  background: var(--accent-soft);
  border-style: solid;
  border-color: var(--accent-ring);
}
</style>
