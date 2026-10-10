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
import { editorViewCtx } from '@milkdown/kit/core';
import { createNoteEditor } from './create-editor';
import { EMPTY_SNAPSHOT, insertImage, snapshotOf, type ToolbarSnapshot } from './commands';
import EditorToolbar from './EditorToolbar.vue';
import FloatingToolbar from './FloatingToolbar.vue';
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
  }>(),
  { readonly: false, mode: 'wysiwyg' },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  save: [];
  /** 工具栏点了「图片」，交给上层决定从哪拿文件 */
  'pick-image': [];
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
  float.value = { x: (start.left + end.right) / 2, y: Math.min(start.top, end.top) - 8 };
}

function report(markdown: string): void {
  blank.value = markdown.trim() === '';
  emit('update:modelValue', markdown);
  emit('save');
}

async function boot(): Promise<void> {
  if (props.mode !== 'wysiwyg' || !host.value) return;
  const instance = createNoteEditor(host.value, {
    defaultValue: props.modelValue,
    editable: () => !props.readonly,
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

/** 源码模式下的输入：原样往上抛，不经过任何解析或序列化 */
function onSourceInput(event: Event): void {
  report((event.target as HTMLTextAreaElement).value);
}

/** 滚动会让浮层和选区错位，直接收起来最省事 */
function onSurfaceScroll(): void {
  float.value = null;
}

/** 上层上传完图片后调这里，把图插到当前光标处 */
function placeImage(src: string, alt: string): void {
  insertImage(editorRef.value, src, alt);
}

defineExpose({ getEditor: () => editorRef.value, placeImage });
</script>

<template>
  <div class="note-editor" :class="[`is-${mode}`, { 'is-blank': blank }]">
    <EditorToolbar
      v-if="mode === 'wysiwyg' && !readonly"
      class="dock"
      :editor="editorRef"
      :state="toolbarState"
      @image="emit('pick-image')"
    />

    <div
      v-if="mode === 'wysiwyg'"
      ref="host"
      class="donote-surface"
      @scroll="onSurfaceScroll"
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
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  overflow-y: auto;
  transition: background-color var(--dur) var(--ease-smooth);
}

/* 正文为空时告诉用户这里可以写 */
.donote-surface::before {
  content: '用 Markdown 写点什么…';
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
