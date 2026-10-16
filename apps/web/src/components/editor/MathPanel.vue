<script setup lang="ts">
/**
 * 公式编辑面板。
 *
 * 公式本身是编辑器里那个 NodeView（math.ts）画的；这个面板只负责「改 LaTeX」这一件事：
 * 左边源码、右边实时预览，点「完成」把新源码写回块里。
 *
 * 开关状态放在 math.ts 的 `mathEdit`，因为 NodeView 是纯 TS，拿不到 Vue 组件 ——
 * 两边靠这一份状态接上。面板挂一次就够（NoteEditor 里），不随公式的数量增加。
 *
 * 比 MermaidPanel 简单一档：KaTeX 是同步渲染，不用防抖，也没有「丢弃过期结果」的序号，
 * 预览直接挂 computed。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { mathEdit, renderMath } from './math';

const open = computed(() => mathEdit.value !== null);
/** 块级 / 行内：只影响预览怎么排 */
const display = computed(() => mathEdit.value?.display ?? true);
const draft = ref('');
const box = ref<HTMLTextAreaElement | null>(null);

const preview = computed(() => (open.value ? renderMath(draft.value, display.value) : null));

watch(
  () => mathEdit.value,
  (edit) => {
    if (!edit) return;
    draft.value = edit.latex;
    document.body.style.overflow = 'hidden';
    void nextTick(() => box.value?.focus());
  },
);

function close(): void {
  mathEdit.value = null;
  document.body.style.overflow = '';
}

/** 关闭即写回：面板上的唯一出口就是这里 */
function save(): void {
  const edit = mathEdit.value;
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
    <Transition name="math-panel">
      <div v-if="open" class="mask" @click.self="close">
        <div class="panel glass" role="dialog" aria-modal="true" aria-label="编辑公式">
          <header class="head">
            <h2 class="title">编辑公式</h2>
            <p class="tip">左边写 LaTeX，右边即时排版；点「完成」写回笔记</p>
          </header>

          <div class="body">
            <textarea
              ref="box"
              v-model="draft"
              class="source mono"
              spellcheck="false"
              aria-label="LaTeX 源码"
              placeholder="x^2 + y^2 = z^2"
            />
            <div class="preview" aria-label="实时预览">
              <div v-if="preview?.error" class="preview-error">{{ preview.error }}</div>
              <div v-else class="preview-math" v-html="preview?.html" />
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

/* 预览里的公式跟着正文一个颜色（暗 / 亮两套主题靠令牌自动切） */
.preview-math {
  color: var(--text);
}

.preview-math :deep(.katex-display) {
  margin: 0;
  overflow-x: auto;
  overflow-y: hidden;
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

.math-panel-enter-active,
.math-panel-leave-active {
  transition: opacity var(--dur) var(--ease-smooth);
}

.math-panel-enter-active .panel,
.math-panel-leave-active .panel {
  transition: transform var(--dur) var(--ease-spring);
}

.math-panel-enter-from,
.math-panel-leave-to {
  opacity: 0;
}

.math-panel-enter-from .panel,
.math-panel-leave-to .panel {
  transform: translateY(16px) scale(0.97);
}
</style>
