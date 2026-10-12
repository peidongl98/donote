<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { NoteSummaryDTO } from '@donote/shared';
import { notesApi } from '@/storage/notes';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { useLongPress } from '@/utils/long-press';
import { formatTime } from '@/utils/format';
import AppHeader from '@/components/AppHeader.vue';
import AppDialog from '@/components/AppDialog.vue';
import BatchToolbar from '@/components/BatchToolbar.vue';
import NoteActionMenu from '@/components/NoteActionMenu.vue';
import EmptyState from '@/components/EmptyState.vue';

const notes = ref<NoteSummaryDTO[]>([]);
const loading = ref(true);
const ui = useUiStore();
const router = useRouter();
const sync = useSyncStore();
const sel = useSelectionStore();

const hardOpen = ref(false);
const hardTarget = ref<NoteSummaryDTO | null>(null);
const busy = ref(false);
/** 右键打开的那条（回收站菜单只有恢复 / 彻底删除） */
const menuNote = ref<NoteSummaryDTO | null>(null);

/* ------------------------------ 多选 ------------------------------ */

const selectedIds = computed(() => notes.value.map((n) => n.id).filter((id) => sel.has(id)));
const allIds = computed(() => notes.value.map((n) => n.id));
const labelOf = (id: string): string => notes.value.find((n) => n.id === id)?.title ?? '这一项';

const pressId = ref('');
const press = useLongPress(() => enterSelect(pressId.value));

function startPress(id: string, event: PointerEvent): void {
  pressId.value = id;
  press.start(event);
}

function enterSelect(id: string): void {
  if (!sel.selecting) sel.enterSelecting('trash');
  if (id) sel.toggle(id);
}

function onPick(id: string): void {
  if (sel.selecting) sel.toggle(id);
  else enterSelect(id);
}

/** 多选态下点标题只改选中，不跳笔记详情 */
function onOpen(note: NoteSummaryDTO): void {
  if (press.consume()) return;
  if (sel.selecting) {
    sel.toggle(note.id);
    return;
  }
  void router.push(`/notes/${note.id}`);
}

/** 触屏长按会同时补一个 contextmenu，别让它再叠一层单条菜单 */
function onMenu(note: NoteSummaryDTO): void {
  if (press.recent()) return;
  menuNote.value = note;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    notes.value = (await notesApi.list({ trash: true })).items;
  } catch {
    ui.toast('回收站加载失败');
  } finally {
    loading.value = false;
  }
}

async function restore(note: NoteSummaryDTO): Promise<void> {
  busy.value = true;
  try {
    await notesApi.restore(note.id);
    ui.toast('已恢复');
    await load();
  } catch {
    ui.toast('恢复失败');
  } finally {
    busy.value = false;
  }
}

async function hardDelete(): Promise<void> {
  const target = hardTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await notesApi.remove(target.id, true);
    ui.toast('已彻底删除');
    hardOpen.value = false;
    await load();
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

onMounted(load);

/** 缓存层在后台校验出云端有更新，列表跟着刷一次 */
watch(() => sync.dataVersion, load);
</script>

<template>
  <div class="page page-full">
    <AppHeader :crumbs="[{ label: '回收站' }]" back back-to="/settings" />

    <div class="page-body">
      <EmptyState v-if="loading" loading title="加载中" />

      <EmptyState v-else-if="!notes.length" title="回收站是空的" hint="删除笔记后会先进入这里，随时可以恢复">
        <template #icon>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path
              d="M6 7.5h12M9.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v1.5M8 7.5l.6 10A1.5 1.5 0 0 0 10.1 19h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </template>
      </EmptyState>

      <div v-else class="stack">
        <div
          v-for="note in notes"
          :key="note.id"
          class="row-card card-plain"
          :class="{ 'is-selectable': sel.selecting, 'is-selected': sel.has(note.id) }"
          @contextmenu.prevent="onMenu(note)"
          @pointerdown="startPress(note.id, $event)"
          @pointerup="press.cancel"
          @pointercancel="press.cancel"
          @pointerleave="press.cancel"
        >
          <button
            type="button"
            class="pick"
            :aria-pressed="sel.has(note.id)"
            :aria-label="sel.has(note.id) ? '取消选择' : '选择'"
            @click.stop="onPick(note.id)"
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

          <button type="button" class="main" @click="onOpen(note)">
            <span class="title">{{ note.title }}</span>
            <span class="time">删除于 {{ formatTime(note.deleted_at) }}</span>
          </button>
          <div class="ops">
            <button type="button" class="btn-ghost small" :disabled="busy" @click="restore(note)">
              恢复
            </button>
            <button
              type="button"
              class="btn-ghost small is-danger"
              @click="hardTarget = note; hardOpen = true"
            >
              彻底删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <BatchToolbar
      v-if="sel.selecting"
      context="trash"
      :ids="selectedIds"
      :all-ids="allIds"
      :label-of="labelOf"
      @done="load"
    />

    <NoteActionMenu
      :note="menuNote"
      mode="trash"
      @close="menuNote = null"
      @done="load"
    />

    <AppDialog
      :open="hardOpen"
      title="彻底删除？"
      confirm-label="彻底删除"
      danger
      :busy="busy"
      @close="hardOpen = false"
      @confirm="hardDelete"
    >
      <p class="tip">「{{ hardTarget?.title }}」将被从你的网盘里永久删除，无法恢复。</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.row-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  /* 左侧永久留出勾选框的位置：只在悬停时让位会让标题横向跳一下 */
  padding-left: 44px;
}

.row-card.is-selected {
  background: var(--accent-soft);
}

/* 悬停勾选框：桌面端进多选的入口；收起时不占点击 */
.pick {
  position: absolute;
  top: 12px;
  left: 10px;
  z-index: 1;
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

.row-card:hover .pick,
.row-card.is-selectable .pick,
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

/* 勾选框的位置已在 .row-card 的 padding-left 里留出，这里不用再推 .main */
.main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  color: inherit;
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.time {
  font-size: 12px;
  color: var(--text-2);
}

.ops {
  display: flex;
  gap: 6px;
}

.btn-ghost.small {
  height: 34px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
}

.btn-ghost.small.is-danger {
  color: var(--danger);
}

.tip {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
</style>
