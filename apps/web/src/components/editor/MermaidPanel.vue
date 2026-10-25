<script setup lang="ts">
/**
 * 图编辑面板（双模式）。
 *
 * 图本身是编辑器里那个 NodeView（mermaid.ts）画的；这个面板负责改它，两种改法：
 * - **可视化**（默认）：按内容自动换成两种画布之一 ——
 *   `mindmap` 给 `MindmapEditor`（自动布局的树），`flowchart` 给 `FlowchartEditor`
 *   （节点自由摆放、任意两个节点都能连线）。每次改动都序列化回 mermaid 文本，写进 `draft`
 *   —— 数据始终只有一份。
 * - **代码**：左边源码、右边实时预览，给要写时序图或者想精确控制样式的人用。
 *
 * 能不能进可视化只取决于一块：这段源码能不能被解析。解析不出来（时序图、类图、写坏的语法）
 * 就停在代码模式并说明原因；切回去时用新源码重新解析。
 *
 * 开关状态放在 mermaid.ts 的 `mermaidEdit`，因为 NodeView 是纯 TS，拿不到 Vue 组件 ——
 * 两边靠这一份状态接上。面板挂一次就够（NoteEditor 里），不随块的数量增加。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { mermaidEdit, renderMermaid } from './mermaid';
import { parseMindmap, serializeMindmap, type MindNode } from './mindmap';
import { parseFlowchart, serializeFlowchart, type FlowDoc } from './flowchart';
import MindmapEditor from './MindmapEditor.vue';
import FlowchartEditor from './FlowchartEditor.vue';

const open = computed(() => mermaidEdit.value !== null);
const draft = ref('');
const preview = ref('');
const previewError = ref('');
const box = ref<HTMLTextAreaElement | null>(null);

/** 当前模式。默认可视化 —— 不会写代码的人从这一步就不必看见语法 */
const mode = ref<'visual' | 'code'>('visual');
/** 这段源码能被画成哪种图；null = 画不了，只能改代码 */
const kind = ref<'mindmap' | 'flowchart' | null>(null);
/** 可视化模式编辑的那棵树 / 那张图 */
const tree = ref<MindNode | null>(null);
const flow = ref<FlowDoc | null>(null);
/** 代码模式下手写的源码解析不出来时，切可视化要说明为什么没切过去 */
const switchHint = ref('');

const panelTitle = computed(() => (kind.value === 'flowchart' ? '编辑流程图' : '编辑思维导图'));

const tipText = computed(() => {
  if (mode.value !== 'visual') return '左边改源码，右边即时出图；点「完成」写回笔记';
  if (kind.value === 'flowchart') {
    return '拖节点摆位置 · 按住节点右侧的圆点拖到另一个节点上连线 · 双击改字或改线上文字';
  }
  return '在图上直接改：双击改字 · Tab 加下级 · 回车加同级 · 拖到另一个节点上换父级';
});

/** 两种图试一遍。顺序不重要 —— 一段源码不可能既是 mindmap 又是 flowchart */
function detect(code: string): { kind: 'mindmap' | 'flowchart'; tree?: MindNode; flow?: FlowDoc } | null {
  const mindmap = parseMindmap(code);
  if (mindmap) return { kind: 'mindmap', tree: mindmap };
  const chart = parseFlowchart(code);
  if (chart) return { kind: 'flowchart', flow: chart };
  return null;
}

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
    switchHint.value = '';
    const found = detect(edit.code);
    kind.value = found?.kind ?? null;
    tree.value = found?.tree ?? null;
    flow.value = found?.flow ?? null;
    mode.value = found ? 'visual' : 'code';
    void paint(edit.code);
    document.body.style.overflow = 'hidden';
    // 可视化模式不抢焦点：画布自己会在点击节点时接管，抢先聚焦反而让弹窗里多出一个光标
    if (!found) void nextTick(() => box.value?.focus());
  },
);

// 只有代码模式需要那张预览图。可视化模式里图就是预览，再渲染一遍等于每次拖动都跑一次 mermaid
watch(draft, (value) => {
  if (mode.value === 'code') schedule(value);
});

watch(mode, (value) => {
  if (value === 'code') schedule(draft.value);
});

/*
 * 图 → 文本：可视化里的每一次改动都落成 mermaid 源码，`draft` 因此永远是唯一真相。
 * 只在可视化模式下回写 —— 代码模式里 `draft` 是用户自己敲的，盖掉就等于吃字。
 */
watch(tree, (value) => {
  if (mode.value !== 'visual' || !value) return;
  const next = serializeMindmap(value);
  if (next !== draft.value) draft.value = next;
});

watch(flow, (value) => {
  if (mode.value !== 'visual' || !value) return;
  const next = serializeFlowchart(value);
  if (next !== draft.value) draft.value = next;
});

/** 切换模式。切到可视化前用**当前源码**重新解析，代码里的改动立刻生效 */
function setMode(next: 'visual' | 'code'): void {
  if (next === mode.value) return;
  switchHint.value = '';
  if (next === 'visual') {
    const found = detect(draft.value);
    if (!found) {
      switchHint.value = '这段代码画不成图（只有思维导图和流程图能可视化），只能改代码';
      return;
    }
    kind.value = found.kind;
    tree.value = found.tree ?? null;
    flow.value = found.flow ?? null;
    // 解析过的形状可能跟源码不完全一样（多写了空格、坐标注释被挪过位置），以图为准写回去
    const canonical = found.tree ? serializeMindmap(found.tree) : found.flow ? serializeFlowchart(found.flow) : draft.value;
    if (canonical !== draft.value) draft.value = canonical;
  } else {
    // 切回代码前把图的最新样子落成文本，免得两边不一致
    if (tree.value) draft.value = serializeMindmap(tree.value);
    else if (flow.value) draft.value = serializeFlowchart(flow.value);
    void nextTick(() => box.value?.focus());
  }
  mode.value = next;
}

/**
 * 导图 → 嵌套列表。
 *
 * 先把面板里的草稿写回块里，再让块自己换成列表 —— 两条路都走同一份数据，
 * 不会出现「面板里改过的内容没带上」。
 */
function toList(): void {
  const edit = mermaidEdit.value;
  if (!edit?.toList) return;
  edit.apply(draft.value);
  edit.toList();
  close();
}

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
  // 节点里正在改字时，Esc 归输入框（取消这次编辑），不该把整个弹窗关掉
  const target = event.target as HTMLElement | null;
  if (event.key === 'Escape' && target && (target.tagName === 'INPUT' || target.isContentEditable)) {
    return;
  }
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
        <div class="panel glass" role="dialog" aria-modal="true" :aria-label="panelTitle">
          <header class="head">
            <div class="head-row">
              <h2 class="title">{{ panelTitle }}</h2>
              <!--
                模式开关：默认可视化。会写代码的人切到「代码」，两边改的是同一段源码，
                所以怎么切都不会丢东西（样式指令除外，见上面的说明）。
              -->
              <div class="tabs" role="tablist" aria-label="编辑模式">
                <button
                  type="button"
                  class="tab"
                  role="tab"
                  :class="{ 'is-on': mode === 'visual' }"
                  :aria-selected="mode === 'visual'"
                  @click="setMode('visual')"
                >
                  可视化
                </button>
                <button
                  type="button"
                  class="tab"
                  role="tab"
                  :class="{ 'is-on': mode === 'code' }"
                  :aria-selected="mode === 'code'"
                  @click="setMode('code')"
                >
                  代码
                </button>
              </div>
            </div>
            <p class="tip">{{ tipText }}</p>
            <p v-if="switchHint" class="switch-hint">{{ switchHint }}</p>
          </header>

          <!--
            可视化：整块给画布，不再分左右两栏 —— 图本身就是预览。
            两种图两种画布，用户不必知道自己那段源码属于哪一类。
          -->
          <div v-if="mode === 'visual' && tree" class="body is-visual">
            <MindmapEditor :tree="tree" @update:tree="(next) => (tree = next)" />
          </div>

          <div v-else-if="mode === 'visual' && flow" class="body is-visual">
            <FlowchartEditor :doc="flow" @update:doc="(next) => (flow = next)" />
          </div>

          <div v-else class="body">
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
            <!-- 导图 → 大纲：本来就是从列表转过来的，也要能转回去 -->
            <button v-if="kind === 'mindmap' && mode === 'visual'" type="button" class="ghost is-convert" @click="toList">
              转成列表
            </button>
            <span class="foot-gap" />
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

.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

/* 两个分段按钮，不占地方但一眼看出有两条路 */
.tabs {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--r-xs);
  background: var(--surface-2);
  border: 1px solid var(--surface-border);
  flex: none;
}

.tab {
  padding: 3px 12px;
  border-radius: calc(var(--r-xs) - 1px);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: none;
}

.tab.is-on {
  color: var(--text);
  background: var(--surface);
  box-shadow: var(--shadow-1);
}

.switch-hint {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--danger);
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

/* 可视化模式只放一块画布，别继承两栏 */
.body.is-visual {
  display: block;
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
