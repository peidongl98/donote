<script setup lang="ts">
/**
 * Mermaid 源码编辑面板。
 *
 * 图本身是编辑器里那个 NodeView（mermaid.ts）画的；这个面板只负责「改源码」这一件事：
 * 左边源码、右边实时预览，点「完成」把新源码写回块里（块还是 ```mermaid 围栏代码块）。
 *
 * 开关状态放在 mermaid.ts 的 `mermaidEdit`，因为 NodeView 是纯 TS，拿不到 Vue 组件 ——
 * 两边靠这一份状态接上。面板挂一次就够（NoteEditor 里），不随块的数量增加。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { mermaidEdit, renderMermaid } from './mermaid';

const open = computed(() => mermaidEdit.value !== null);
const draft = ref('');
const preview = ref('');
const previewError = ref('');
const box = ref<HTMLTextAreaElement | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
/** 渲染是异步的，用它丢弃过期的结果 */
let token = 0;

async function paint(code: string): Promise<void> {
  const mine = (token += 1);
  const result = await renderMermaid(code);
  if (mine !== token) return;
  previewError.value = result.error ?? '';
  preview.value = result.svg ?? '';
}

function schedule(code: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void paint(code), 260);
}

watch(
  () => mermaidEdit.value,
  (edit) => {
    if (!edit) {
      if (timer) clearTimeout(timer);
      return;
    }
    draft.value = edit.code;
    preview.value = '';
    previewError.value = '';
    void paint(edit.code);
    document.body.style.overflow = 'hidden';
    void nextTick(() => box.value?.focus());
  },
);

watch(draft, (value) => schedule(value));

function close(): void {
  if (timer) clearTimeout(timer);
  mermaidEdit.value = null;
  document.body.style.overflow = '';
}

/** 关闭即写回：面板上的唯一出口就是这里 */
function save(): void {
  const edit = mermaidEdit.value;
  if (edit) edit.apply(draft.value);
  close();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
  // Ctrl/Cmd + Enter 等于「完成」，码字时不用去够按钮
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
}

watch(open, (value) => {
  if (value) window.addEventListener('keydown', onKey);
  else window.removeEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition name="mermaid-panel">
      <div v-if="open" class="mask" @click.self="close">
        <div class="panel glass" role="dialog" aria-modal="true" aria-label="编辑思维导图">
          <header class="head">
            <h2 class="title">编辑思维导图</h2>
            <p class="tip">左边改源码，右边即时出图；点「完成」写回笔记</p>
          </header>

          <div class="body">
            <textarea
              ref="box"
              v-model="draft"
              class="source mono"
              spellcheck="false"
              aria-label="Mermaid 源码"
              placeholder="graph TD&#10;  A[开始] --> B[结束]"
            />
            <div class="preview" aria-label="实时预览">
              <div v-if="previewError" class="preview-error">{{ previewError }}</div>
              <div v-else class="preview-svg" v-html="preview" />
            </div>
          </div>

          <footer class="foot">
            <button type="button" class="ghost" @click="close">取消</button>
            <button type="button" class="major" @click="save">完成</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/*
 * 与 AppDialog 同一档（z-index 22）：它俩不会同时出现（面板只从编辑器里开），
 * 遮罩同样按 --content-offset 居中于内容列，窄窗口下不压侧栏。
 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 22;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-2);
  padding-left: calc(var(--sp-2) + var(--content-offset));
  background: rgba(0, 0, 0, 0.42);
}

.panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 880px;
  max-height: min(78vh, 720px);
  padding: var(--sp-2);
  border-radius: var(--r-xl);
  background: var(--glass-bg);
}

.head {
  flex: none;
  padding: 0 4px var(--sp-1);
}

.title {
  font-size: 17px;
  font-weight: 620;
}

.tip {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

/* 两栏：左源码右预览。窄屏放不下就上下堆（见 @media） */
.body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-1);
}

.source {
  min-height: 300px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--bg);
  border: 1px solid var(--surface-border);
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text);
  resize: none;
  tab-size: 2;
}

.source:focus {
  outline: none;
  border-color: var(--accent-ring);
}

.preview {
  min-height: 300px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
  overflow: auto;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-2);
}

.preview-svg :deep(svg) {
  max-width: 100%;
  height: auto;
}

.preview-error {
  text-align: left;
  color: var(--danger);
}

.foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
  padding-top: var(--sp-1);
}

.foot button {
  min-width: 104px;
  height: 40px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-md);
  font-size: 14px;
  font-weight: 600;
  transition:
    transform var(--dur-fast) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-smooth);
}

.foot button:active {
  transform: scale(0.97);
}

.ghost {
  background: var(--surface);
  border: 1px solid var(--surface-border);
  color: var(--text);
}

.major {
  background: var(--accent);
  color: var(--on-accent);
}

@media (max-width: 900px) {
  .body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }

  .source,
  .preview {
    min-height: 160px;
  }
}

.mermaid-panel-enter-active,
.mermaid-panel-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.mermaid-panel-enter-active .panel,
.mermaid-panel-leave-active .panel {
  transition: transform var(--dur) var(--ease-spring);
}

.mermaid-panel-enter-from,
.mermaid-panel-leave-to {
  opacity: 0;
}

.mermaid-panel-enter-from .panel,
.mermaid-panel-leave-to .panel {
  transform: translateY(16px) scale(0.97);
}
</style>
