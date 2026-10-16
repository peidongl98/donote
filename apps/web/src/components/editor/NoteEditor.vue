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

function refresh(ctx: Ctx): void {
  lastCtx = ctx;
  const view = ctx.get(editorViewCtx);
  // 监听器会在编辑器建好之前就被注册，这一小段窗口里取不到视图，直接跳过
  if (!view || !view.state) return;
  toolbarState.value = snapshotOf(view);

  const { selection } = view.state;
  if (props.readonly || selection.empty) {
    float.value = null;
    return;
  }
  const start = view.coordsAtPos(selection.from);
  const end = view.coordsAtPos(selection.to);
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
    onSelectionUpdated: (ctx) => refresh(ctx),
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

    <div
      v-if="mode === 'wysiwyg'"
      ref="host"
      class="donote-surface"
      :style="{ '--doc-font-size': `${docFontSize}px` }"
      @scroll="onSurfaceScroll"
      @keydown="onFontKey"
    />

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
   * 正文直接铺在页面背景上，不做卡片 —— 底色 / 边框 / 圆角 / 内边距都不给。
   * 滚动留在这一层：标题输入框与标签条在它**外面**（同级、更靠上），
   * 所以滚正文时标题与标签条不会跟着走，一直看得见自己在哪篇笔记。
   */
  overflow-y: auto;
}

/* 正文为空时告诉用户这里可以写。所见即所得里不该提 Markdown —— 正文根本不出现符号，
   提了反而让人以为要手写 # 和 **。源码模式那句（textarea 的 placeholder）是对的，保留。 */
.donote-surface::before {
  content: '写点什么吧';
  position: absolute;
  top: var(--sp-3);
  left: var(--sp-4);
  color: var(--text-2);
  opacity: 0;
  pointer-events: none;
}

.note-editor.is-blank .donote-surface::before {
  opacity: 0.5;
}

.source {
  flex: 1 1 auto;
  min-height: 46vh;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-lg);
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
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  overflow-y: auto;
}

.source:focus {
  outline: none;
}

/* 移动端：工具栏挪到正文下方，拇指够得着 */
@media (max-width: 1023px) {
  .dock {
    order: 2;
  }

  .donote-surface {
    order: 1;
    padding: var(--sp-2);
    min-height: 40vh;
  }

  .split {
    order: 1;
  }

  .split .source,
  .source-preview {
    padding: var(--sp-2);
  }
}

/* 窄屏并排放不下，预览挪到源码下面 */
@media (max-width: 900px) {
  .split {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
}
</style>
