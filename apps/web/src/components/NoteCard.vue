<script setup lang="ts">
import { computed } from 'vue';
import type { NoteSummaryDTO } from '@donote/shared';
import { cleanExcerpt, formatTime } from '@/utils/format';
import { useSyncStore } from '@/stores/sync';
import { useLongPress } from '@/utils/long-press';

const props = defineProps<{
  note: NoteSummaryDTO;
  folderName?: string | null;
  /** 多选态：卡片不再跳转，点一下就是切换选中 */
  selectable?: boolean;
  selected?: boolean;
}>();
const emit = defineEmits<{
  menu: [note: NoteSummaryDTO];
  /** 悬停勾选框：进入多选并选中这一条 */
  enter: [id: string];
  toggle: [id: string];
  longpress: [note: NoteSummaryDTO];
}>();

const sync = useSyncStore();
const excerpt = computed(() => cleanExcerpt(props.note.excerpt).slice(0, 90));
/** 本机还没有正文副本 —— 断网时这篇打不开，所以画成浅灰 */
const uncached = computed(() => !props.note.deleted_at && !sync.hasCopy(props.note.id));

const press = useLongPress(() => emit('longpress', props.note));

/**
 * 多选态和长按都要拦掉跳转。
 *
 * 🔴 必须在**捕获阶段**拦：`RouterLink` 自己的 `onClick` 挂在 `<a>` 上、在目标阶段跑，
 * 比模板上写的冒泡处理器更早，它那边 `guardEvent` 已经检查过 `defaultPrevented` 了 ——
 * 在冒泡里 `preventDefault` 是拦不住的，实测会照跳。捕获阶段在卡片上先跑才来得及改这次事件。
 */
function onCapture(event: MouseEvent): void {
  // 卡片上的按钮各有各的活（勾选框切换、⋯ 开菜单），放它们走自己的路
  if ((event.target as HTMLElement | null)?.closest('button')) return;
  const long = press.consume();
  if (!props.selectable && !long) return;
  event.preventDefault();
  event.stopPropagation();
  if (props.selectable && !long) emit('toggle', props.note.id);
}

/** 悬停勾选框既是「进多选」也是「在多选里换选中」 */
function onPick(): void {
  if (props.selectable) emit('toggle', props.note.id);
  else emit('enter', props.note.id);
}

/** 触屏长按会同时补一个 contextmenu，别让它再叠一层单条菜单 */
function onMenu(): void {
  if (press.recent()) return;
  emit('menu', props.note);
}
</script>

<template>
  <div
    class="card glass"
    :class="{ 'is-uncached': uncached, 'is-selectable': selectable, 'is-selected': selected }"
    @contextmenu.prevent="onMenu"
    @click.capture="onCapture"
    @pointerdown="press.start"
    @pointerup="press.cancel"
    @pointercancel="press.cancel"
    @pointerleave="press.cancel"
  >
    <button
      type="button"
      class="pick"
      :aria-pressed="!!selected"
      :aria-label="selected ? '取消选择' : '选择'"
      @click.stop="onPick"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="m5 12.5 4.5 4.5L19 7.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <RouterLink class="main" :to="`/notes/${note.id}`">
      <div class="top">
        <!-- 目录名与笔记名可以同名，前缀图标用来区分两者 -->
        <h3 class="title">📄 {{ note.title }}</h3>
        <time class="time">{{ formatTime(note.updated_at) }}</time>
      </div>
      <p v-if="excerpt" class="excerpt">{{ excerpt }}</p>
      <span v-if="folderName" class="folder">📁 {{ folderName }}</span>
      <span v-if="note.deleted_at" class="deleted">已删除</span>
    </RouterLink>

    <button class="more" type="button" aria-label="更多操作" @click.prevent.stop="emit('menu', note)">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6" fill="currentColor" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        <circle cx="19" cy="12" r="1.6" fill="currentColor" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  border-radius: var(--r-lg);
  transition:
    transform var(--dur) var(--ease-spring),
    box-shadow var(--dur) var(--ease-smooth);
}

.card:hover {
  transform: translateY(-2px);
}

.card:active {
  transform: scale(0.99);
}

.main {
  display: block;
  /* 左侧永久留出勾选框的位置。只在悬停时才让位会让标题横向跳一下，
     所以宁可一直空着 —— 与列表里其它选中控件的位置也保持一致。 */
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-5);
  text-decoration: none;
  color: inherit;
}

.top {
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
  /* 给右上角的「更多」让位，否则时间会被压住 */
  padding-right: 30px;
}

.title {
  flex: 1 1 auto;
  font-size: 16px;
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}

.more {
  position: absolute;
  top: 8px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-pill);
  color: var(--text-2);
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth);
}

.card:hover .more,
.more:focus-visible {
  opacity: 1;
}

.more:hover {
  color: var(--text);
  background: var(--surface);
}

/* 触屏没有 hover，常显 */
@media (hover: none) {
  .more {
    opacity: 1;
  }
}

.excerpt {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.folder,
.deleted {
  display: inline-block;
  margin-top: var(--sp-1);
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-size: 11px;
  background: var(--accent-soft);
  color: var(--accent);
}

.deleted {
  margin-left: 6px;
  background: var(--danger-soft);
  color: var(--danger);
}

/*
 * 悬停勾选框：桌面端进多选的入口。
 * 收起时 `pointer-events: none`，不挡卡片本身的跳转；触屏没有 hover，
 * 能切到这条规则的只有 `.is-selectable` —— 触屏是靠长按进多选的，两条路各管各的。
 *
 * 🔴 z-index 必须 > 2：glass.css 有一条全局的 `.glass > * { position: relative; z-index: 2 }`，
 * 卡片里的 `.main` 也被抬到 2 了。同层的话按 DOM 顺序排，勾选框在前面就会被标题盖住，
 * 看起来「能看见」但点不到。
 */
.pick {
  position: absolute;
  top: 16px;
  left: 14px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--surface-border);
  background: var(--surface);
  color: transparent;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-smooth),
    background-color var(--dur-fast) var(--ease-smooth),
    border-color var(--dur-fast) var(--ease-smooth),
    color var(--dur-fast) var(--ease-smooth);
}

.card:hover .pick,
.card.is-selectable .pick,
.pick:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.pick:hover {
  border-color: var(--accent);
}

.pick[aria-pressed='true'] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

/* 多选态给勾选框让位 —— 位置已在 .main 里永久留出，这里只加重选中态 */
.card.is-selected {
  box-shadow: 0 0 0 2px var(--accent);
}

/* 没缓存的笔记：正文还没落到本机，断网读不到，画浅一点提示用户 */
.card.is-uncached .title,
.card.is-uncached .excerpt {
  color: var(--text-2);
  opacity: 0.6;
}
</style>
