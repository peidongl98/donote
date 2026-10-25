<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { computed } from 'vue';

const props = defineProps<{ source: string; empty?: string }>();

// html: false —— 不允许原始 HTML 穿透，避免把笔记内容变成 XSS 载体
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const html = computed(() => (props.source.trim() ? md.render(props.source) : ''));
</script>

<template>
  <div v-if="html" class="md" v-html="html" />
  <p v-else class="md-empty">{{ empty ?? '还没有内容' }}</p>
</template>

<style scoped>
.md {
  font-size: 16px;
  line-height: 1.75;
  color: var(--text);
  word-break: break-word;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: var(--sp-3) 0 var(--sp-1);
  line-height: 1.35;
  font-weight: 650;
}

.md :deep(h1) {
  font-size: 24px;
}

.md :deep(h2) {
  font-size: 20px;
}

.md :deep(h3) {
  font-size: 17px;
}

.md :deep(h4) {
  font-size: 16px;
}

.md :deep(p) {
  margin: var(--sp-2) 0;
}

.md :deep(a) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent-ring);
}

/*
 * 列表的缩进与每级标记不在这里：编辑器和这里必须是同一套，
 * 统一由 `styles/list-style.css` 提供（`.md` 已在它的选择器里）。
 * 这里再写一份 padding-left 就会把层级缩进盖掉。
 */

.md :deep(code) {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--surface-border);
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.md :deep(pre) {
  margin: var(--sp-2) 0;
  padding: var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface);
  border: 1px solid var(--surface-border);
  overflow-x: auto;
}

.md :deep(pre code) {
  padding: 0;
  border: none;
  background: none;
  font-size: 14px;
  line-height: 1.6;
}

.md :deep(blockquote) {
  margin: var(--sp-2) 0;
  padding: var(--sp-1) var(--sp-2);
  border-left: 3px solid var(--accent-ring);
  color: var(--text-2);
}

.md :deep(table) {
  width: 100%;
  margin: var(--sp-2) 0;
  border-collapse: collapse;
  font-size: 15px;
}

.md :deep(th),
.md :deep(td) {
  padding: 8px 10px;
  border: 1px solid var(--divider);
  text-align: left;
}

.md :deep(th) {
  background: var(--surface);
  font-weight: 600;
}

.md :deep(hr) {
  margin: var(--sp-3) 0;
  border: none;
  border-top: 1px solid var(--divider);
}

.md :deep(img) {
  max-width: 100%;
  border-radius: var(--r-sm);
}

.md-empty {
  color: var(--text-2);
  font-size: 15px;
}
</style>
