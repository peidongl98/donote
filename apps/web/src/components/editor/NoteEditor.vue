<script setup lang="ts">
/**
 * Markdown 笔记编辑器。
 *
 * 两种模式：
 * - `wysiwyg` Milkdown 接管内容，正文里不出现 Markdown 符号；保存时由它把文档序列化回 Markdown。
 * - `source`  一个纯 textarea，字节进出，一个字符都不改。渲染出问题时切过来手工修。
 *
 * 内容只有一个真相来源：`props.modelValue`。组件内部不另存一份「当前值」，
 * 也就不会出现两个来源互相覆盖的竞态。
 *
 * 有意不加 modelValue 的 watcher：外部改动只可能来自「换了另一篇笔记」，
 * 而详情页用 :key 让每篇笔记重新挂载组件；剩下的场景（源码改完切回所见即所得）
 * 由 mode 的 watcher 用最新的 modelValue 重建，同样接得住。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Selection } from '@milkdown/kit/prose/state';
import type { Editor } from '@milkdown/kit/core';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { createNoteEditor } from './create-editor';
import { EMPTY_SNAPSHOT, insertImage, snapshotOf, type ToolbarSnapshot } from './commands';
import { refreshWikilinks, type WikilinkHandlers } from './wikilink';
import { docFontSize, growDocFont, resetDocFont, shrinkDocFont } from './doc-font';
import EditorToolbar from './EditorToolbar.vue';
import FloatingToolbar from './FloatingToolbar.vue';
import BlockHandle from './BlockHandle.vue';
import SlashMenu from './SlashMenu.vue';
import WikilinkMenu from './WikilinkMenu.vue';
import MermaidPanel from './MermaidPanel.vue';
import MathPanel from './MathPanel.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import './editor.css';

const props = withDefaults(
  defineProps<{
    /** Markdown 正文（不含 frontmatter） */
    modelValue: string;
    /** 只读，用于回收站里的笔记 */
    readonly?: boolean;
    /** 所见即所得 / 源码 */
    mode?: 'wysiwyg' | 'source';
    /**
     * 笔记名 → 笔记 id。`[[…]]` 的着色、补全、以及「目标是否存在」都靠它。
     * 由上层（详情页）拉好传下来，编辑器自己不碰数据层。
     */
    titleIndex?: Record<string, string>;
  }>(),
  { readonly: false, mode: 'wysiwyg', titleIndex: () => ({}) },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  save: [];
  /** 工具栏点了「图片」，交给上层决定从哪拿文件 */
  'pick-image': [];
  /** 点开了 `[[…]]`。上层负责跳转；`exists` 为 false 时先把它建出来 */
  'open-wikilink': [name: string, exists: boolean];
  /** 补全菜单里选了「创建『X』」——插入正文之外还要真的把这篇建出来 */
  'create-note': [name: string];
}>();

const host = ref<HTMLElement | null>(null);
/** 正文为空时挂 is-blank，由 CSS 撑一个占位提示 */
const blank = ref(props.modelValue.trim() === '');
/** 编辑器实例要给工具栏用，必须响应式，否则工具栏拿到的一直是 null */
const editorRef = shallowRef<Editor | null>(null);
const toolbarState = ref<ToolbarSnapshot>({ ...EMPTY_SNAPSHOT });
/** 选中文字时浮出的小工具条位置；null = 不显示 */
const float = ref<{ x: number; y: number } | null>(null);

let lastCtx: Ctx | null = null;

/** 浮条渲染宽度约 167px（5 个 28px 按钮 + 分隔线 + 内边距），取一半用来夹位置 */
const FLOAT_HALF_W = 84;

/**
 * 刷新工具栏快照与浮条。
 *
 * `current` 是**刚刚发生的那次选区**。Milkdown 的 selectionUpdated 是在事务 apply 阶段
 * 回调的，那一刻 `view.state` 还是上一份，所以「第 N 级」、加粗 / 斜体高亮、浮条位置
 * 都要用回调给的这个选区算，否则全是上一条的状态。没传时才回落到 view.state。
 *
 * 🔴 不要改成 `queueMicrotask` 延后读 view.state：旧编辑器的回调会在它被销毁之后才跑，
 * 那时 `ctx` 已经失效，浮条会整段不出现（stage7 抓到过）。
 */
function refresh(ctx: Ctx, current?: Selection): void {
  lastCtx = ctx;
  const view = ctx.get(editorViewCtx);
  // 监听器会在编辑器建好之前就被注册，这一小段窗口里取不到视图，直接跳过
  if (!view || !view.state) return;
  const selection = current ?? view.state.selection;
  toolbarState.value = snapshotOf(view, selection);

  /*
   * 浮条的位置要问 DOM，而 `coordsAtPos` 是拿 **view.state** 解析位置的 ——
   * 回调进来的选区却是按新文档算的。碰上「新文档比旧文档长、且选到末尾」的事务
   * （加列表、多段转列表都会这样），位置会越界抛 "Position N out of range"，
   * 崩在事件处理里就是「点了没反应」。夹到旧文档范围内即可。
   */
  const size = view.state.doc.content.size;
  const from = Math.min(selection.from, size);
  const to = Math.min(selection.to, size);
  if (props.readonly || from === to) {
    float.value = null;
    return;
  }
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  // 位置按选区中点算，但必须夹在正文栏内：选中**行首**几个字时中点会很靠左，
  // 浮条左端就钻进侧栏底下；侧栏 z-index 20 比浮条 16 高，左端会被切掉看不见。
  const column = view.dom.getBoundingClientRect();
  const mid = (start.left + end.right) / 2;
  float.value = {
    x: Math.min(Math.max(mid, column.left + FLOAT_HALF_W), column.right - FLOAT_HALF_W),
    y: Math.min(start.top, end.top) - 8,
  };
}

function report(markdown: string): void {
  blank.value = markdown.trim() === '';
  emit('update:modelValue', markdown);
  emit('save');
}

/**
 * `[[…]]` 插件要的两个回调。
 *
 * `resolve` 必须同步，而 `titleIndex` 是上层异步拉来的 —— 这里只在**调用时**读
 * `props.titleIndex`，索引更新后由下面那个 watcher 发一次空事务让 decorations 重算。
 */
const wikilink: WikilinkHandlers = {
  resolve: (name) => props.titleIndex[name] ?? null,
  open: (name, exists) => emit('open-wikilink', name, exists),
};

async function boot(): Promise<void> {
  if (props.mode !== 'wysiwyg' || !host.value) return;
  const instance = createNoteEditor(host.value, {
    defaultValue: props.modelValue,
    editable: () => !props.readonly,
    wikilink,
    onMarkdownUpdated: report,
    onSelectionUpdated: (ctx, selection) => refresh(ctx, selection),
    onUpdated: (ctx) => refresh(ctx),
    onFocus: () => {
      if (lastCtx) refresh(lastCtx);
    },
  });
  await instance.create();
  editorRef.value = instance;
  await instance.action((ctx) => refresh(ctx));
}

async function teardown(): Promise<void> {
  const instance = editorRef.value;
  editorRef.value = null;
  float.value = null;
  lastCtx = null;
  // 复位快照：切到源码模式后编辑器没了，顶栏的撤销/重做不能还挂着上一次的「可撤销」
  toolbarState.value = { ...EMPTY_SNAPSHOT };
  if (instance) await instance.destroy();
}

onMounted(() => void boot());
onBeforeUnmount(() => void teardown());

// 切模式必须整个换掉：所见即所得下这块 DOM 由 ProseMirror 独占，源码模式要的是裸 textarea，
// 两者无法共存。切回时用最新的 modelValue 重建，源码里改的字一个不丢。
watch(
  () => props.mode,
  async () => {
    await teardown();
    await nextTick();
    await boot();
  },
);

// 索引到货 / 变新（刚建了一篇）之后，已经渲染出来的 `[[…]]` 要重新判一次「目标在不在」——
// decorations 只在文档变化时重算，所以这里发一次空事务催它重算。
watch(
  () => props.titleIndex,
  () => void refreshWikilinks(editorRef.value),
);

/** 源码模式下的输入：原样往上抛，不经过任何解析或序列化 */
function onSourceInput(event: Event): void {
  report((event.target as HTMLTextAreaElement).value);
}

/** 滚动会让浮层和选区错位，直接收起来最省事 */
function onSurfaceScroll(): void {
  float.value = null;
}

/**
 * 正文字号快捷键。
 *
 * 挂在正文容器上而不是 window：事件只在编辑器内部有焦点时才冒泡到这里，
 * 所以侧栏、列表页按 Ctrl+± 仍然是浏览器缩放 —— 不全域接管。
 */
function onFontKey(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (event.key === '=' || event.key === '+') {
    event.preventDefault();
    growDocFont();
    return;
  }
  if (event.key === '-') {
    event.preventDefault();
    shrinkDocFont();
    return;
  }
  if (event.key === '0') {
    event.preventDefault();
    resetDocFont();
  }
}

/** 当前正文的 Markdown。序列化要 ctx，而 ctx 在刷新回调里存过一份，这里同步取得到 */
function currentMarkdown(): string | null {
  const view = lastCtx?.get(editorViewCtx);
  if (!lastCtx || !view?.state) return null;
  return lastCtx.get(serializerCtx)(view.state.doc);
}

/**
 * 上层上传完图片后调这里，把图插到当前光标处。
 *
 * 🔴 返回前必须把新正文上报出去，不能等 listener 插件那 200ms 序列化防抖。
 * 这段窗口里 `modelValue` 还是旧正文、上层 status 还停在「已保存」，
 * 于是「插图后马上点别的笔记」会落盘成**不带图**的旧正文 —— 附件已经传上去了，图就丢了。
 */
async function placeImage(src: string, alt: string): Promise<void> {
  await insertImage(editorRef.value, src, alt);
  const markdown = currentMarkdown();
  if (markdown !== null && markdown !== props.modelValue) report(markdown);
}

defineExpose({
  getEditor: () => editorRef.value,
  placeImage,
  /** 工具栏快照（顶栏的撤销 / 重做按钮据此判断能不能按） */
  state: toolbarState,
});
</script>

<template>
  <div class="note-editor" :class="[`is-${mode}`, { 'is-blank': blank }]">
    <EditorToolbar
      v-if="mode === 'wysiwyg' && !readonly"
      class="dock"
      :editor="editorRef"
      :state="toolbarState"
      :title-index="titleIndex"
      @image="emit('pick-image')"
    />

    <!--
      正文框外面再套一层：调宽提示线要**正好贴着正文框的高度**，不能从标题一路贯下来。
      这层只当定位锚点，高度完全由里面的正文框撑开（flex 一路传下去）。
    -->
    <div v-if="mode === 'wysiwyg'" class="surface-slot">
      <div
        ref="host"
        class="donote-surface"
        :style="{ '--doc-font-size': `${docFontSize}px` }"
        @scroll="onSurfaceScroll"
        @keydown="onFontKey"
      />
    </div>

    <!-- 块级手柄：悬停块左侧的 ⋮⋮（fixed 定位，不能放进 .donote-surface，会被 overflow 裁掉） -->
    <BlockHandle v-if="mode === 'wysiwyg' && !readonly" :editor="editorRef" />
    <!-- `/` 命令菜单：同样 fixed 定位 -->
    <SlashMenu
      v-if="mode === 'wysiwyg' && !readonly"
      :editor="editorRef"
      @pick-image="emit('pick-image')"
    />
    <!-- `[[` 笔记链接补全：同样 fixed 定位 -->
    <WikilinkMenu
      v-if="mode === 'wysiwyg' && !readonly"
      :editor="editorRef"
      :title-index="titleIndex"
      @create="emit('create-note', $event)"
    />

    <div v-else class="split">
      <textarea
        class="source mono"
        :value="modelValue"
        :readonly="readonly"
        spellcheck="false"
        aria-label="Markdown 源码"
        placeholder="用 Markdown 写点什么…"
        @input="onSourceInput"
      />
      <div class="source-preview" aria-label="Markdown 预览">
        <MarkdownView :source="modelValue" empty="左边写点什么，这里就会出来" />
      </div>
    </div>

    <FloatingToolbar
      v-if="float && editorRef"
      :editor="editorRef"
      :state="toolbarState"
      :x="float.x"
      :y="float.y"
    />

    <!-- 思维导图的源码面板：点编辑器里的图打开，开关状态在 mermaid.ts 里 -->
    <MermaidPanel />
    <!-- 公式的面板：点正文里的公式打开（块级与行内共用），开关状态在 math.ts 里 -->
    <MathPanel />
  </div>
</template>

<style scoped>
.note-editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: var(--sp-1);
}

.donote-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 46vh;
  /*
   * 正文区是一块可感知的范围（极淡底色 + 细边 + 圆角），不是纯白铺满 ——
   * 与工具栏同一套配方，改回卡片式的那层「文本框」感。
   *
   * 内边距走 --surface-pad-*，提示文字用**同一组变量**定位：改一处两边同步。
   * 之前提示比光标右下各偏 12 / 16 像素，就是内边距撤掉后提示的硬编码偏移没跟着动。
   *
   * 滚动留在这一层：标题输入框与标签条在它**外面**（同级、更靠上），
   * 所以滚正文时标题与标签条不会跟着走，一直看得见自己在哪篇笔记。
   */
  --surface-pad-y: var(--sp-3);
  --surface-pad-x: var(--sp-4);
  padding: var(--surface-pad-y) var(--surface-pad-x);
  /* 圆角跟工具栏同一档（--r-md）：两块上下紧邻，半径不一致会很显眼 */
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  transition: background-color var(--dur) var(--ease-smooth);
  overflow-y: auto;
}

/* 正文为空时告诉用户这里可以写。所见即所得里不该提 Markdown —— 正文根本不出现符号，
   提了反而让人以为要手写 # 和 **。源码模式那句（textarea 的 placeholder）是对的，保留。
   位置与字号都跟着正文走：起点＝内边距，字号＝--doc-font-size。 */
.donote-surface::before {
  content: '写点什么吧';
  position: absolute;
  top: var(--surface-pad-y);
  left: var(--surface-pad-x);
  color: var(--text-2);
  font-size: var(--doc-font-size, 16px);
  line-height: 1.75;
  opacity: 0;
  pointer-events: none;
}

.note-editor.is-blank .donote-surface::before {
  opacity: 0.5;
}

/*
 * 正文框的定位锚点：只负责「正文框从哪到哪」，本身不可见。
 * flex 一路传下去，正文框照旧撑满剩余高度（min-height: 46vh 还在正文框自己身上）。
 */
.surface-slot {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * 调宽提示线：**只贴正文框的左右边界**，从框顶到框底，上下各让 8px 收个圆头。
 *
 * 画在这层而不是 .donote-surface 自己身上 —— 那层是 `overflow-y: auto`，外侧的线会被裁掉。
 * 亮不亮由外面传进来的 --grip-line 决定（按住 Ctrl 或拖动中 = 1），默认 0 即全透明。
 */
.surface-slot::before,
.surface-slot::after {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 8px;
  width: 1px;
  border-radius: 1px;
  background: var(--accent);
  opacity: calc(var(--grip-line, 0) * 0.5);
  transition: opacity var(--dur-fast) var(--ease-smooth);
  pointer-events: none;
}

.surface-slot::before {
  left: -2px;
}

.surface-slot::after {
  right: -2px;
}

.source {
  flex: 1 1 auto;
  min-height: 46vh;
  padding: var(--sp-3) var(--sp-4);
  /* 与所见即所得模式同一档圆角：同一位置切换模式不该换形状 */
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-size: var(--fs-base);
  line-height: var(--lh-relaxed);
  color: var(--text);
  resize: none;
  overflow-y: auto;
}

/* 源码模式：左边源码、右边渲染结果。两栏各自滚动，看的就是同一份正文 */
.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
  flex: 1 1 auto;
  min-height: 46vh;
}

.split .source {
  min-height: 0;
}

.source-preview {
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  overflow-y: auto;
}

.source:focus {
  outline: none;
}

/* 窄屏并排放不下，预览挪到源码下面 */
@media (max-width: 900px) {
  .split {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
