/**
 * 正文基础字号。
 *
 * 只影响渲染：所有标题本来就是 em 相对单位（`h1` 1.7em / `h2` 1.4em / `h3` 1.18em /
 * 行内代码 0.88em），全部挂在 `.ProseMirror` 的那一处 `font-size` 上。
 * 所以改这一个值，全篇标题等比缩放 —— 不需要动任何标题规则，也碰不到 md 内容，
 * 与落盘完全无关。
 *
 * 存在 localStorage：它是「全文基础字号」这个全局偏好，不随笔记走、不跨设备同步。
 */
import { computed, ref } from 'vue';

const KEY = 'donote.doc-font-size';

/** 档位。间距 1px：按一下要看得出来，连续步进太琐碎。 */
export const DOC_FONT_STEPS = [14, 15, 16, 17, 18] as const;
export const DOC_FONT_DEFAULT = 15;

type Step = (typeof DOC_FONT_STEPS)[number];

const isStep = (n: number): n is Step => (DOC_FONT_STEPS as readonly number[]).includes(n);

function read(): Step {
  const raw = Number(localStorage.getItem(KEY));
  return isStep(raw) ? raw : DOC_FONT_DEFAULT;
}

export const docFontSize = ref<Step>(read());

/** 到底了就把按钮置灰 —— 「按了没反应」比置灰更让人困惑 */
export const canShrinkFont = computed(() => docFontSize.value > DOC_FONT_STEPS[0]);
export const canGrowFont = computed(
  () => docFontSize.value < DOC_FONT_STEPS[DOC_FONT_STEPS.length - 1],
);

function set(next: number): void {
  if (!isStep(next) || next === docFontSize.value) return;
  docFontSize.value = next;
  localStorage.setItem(KEY, String(next));
}

export function shrinkDocFont(): void {
  set(docFontSize.value - 1);
}

export function growDocFont(): void {
  set(docFontSize.value + 1);
}

/** 调乱了要有回头路：`Ctrl+0`（或双击字号按钮）回标准档 */
export function resetDocFont(): void {
  set(DOC_FONT_DEFAULT);
}
