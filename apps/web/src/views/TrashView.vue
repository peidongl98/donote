<script setup lang="ts">
/**
 * 回收站：按**顶层条目**组织（一次删除动作 = 一条），树形可展开。
 *
 *   删一篇笔记 → 一条（就是那一篇）
 *   删一个文件夹 → 一条（整棵子树：笔记、子文件夹、各自的 .assets 都在里面）
 *
 * 时间只有顶层条目有，30 天到期整条一起清（自动清理在设置页，见 `purgeExpiredTrash`）。
 * 允许整条恢复，也允许单独恢复 / 彻底删除某一子项 —— 摘出去的子项不再受原时间约束。
 */
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { TrashChild, TrashEntry } from '@/storage/notes';
import {
  DavError,
  encodeId,
  listTrashEntries,
  purgeTrashChild,
  purgeTrashEntry,
  restoreTrashChild,
  restoreTrashEntry,
  trashNoteHasAssets,
} from '@/storage/notes';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { readTrashAuto, runTrashAutoClean } from '@/services/trash-auto';
import AppDialog from '@/components/AppDialog.vue';
import AppHeader from '@/components/AppHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import TrashNode from '@/components/TrashNode.vue';

const entries = ref<TrashEntry[]>([]);
const loading = ref(true);
const busy = ref(false);

const ui = useUiStore();
const sync = useSyncStore();
const router = useRouter();

/** 保留天数（设置项的现值），页面上说一句「到期自动清」时要显示 */
const keepDays = ref(readTrashAuto().days);

/** 右键 / 长按打开的顶层条目（贴内容列的底部弹层，与列表页一致） */
const menuEntry = ref<TrashEntry | null>(null);
/** 待确认的彻底删除 */
const purgeTarget = ref<{ node: TrashEntry | TrashChild; entry: TrashEntry; top: boolean } | null>(null);
/** 单独恢复带附件的笔记：先问一句 */
const assetsTarget = ref<{ node: TrashEntry | TrashChild; entry: TrashEntry } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    entries.value = await listTrashEntries();
  } catch {
    ui.toast('回收站加载失败');
  } finally {
    loading.value = false;
  }
}

/**
 * 打开回收站时的自动清理 —— 先清再列，免得列表里混着刚清掉的条目。
 * 静默：只有真的清掉了才提示一句（用户需要知道东西去哪了）；限流等失败不报错。
 */
async function cleanExpired(): Promise<void> {
  const setting = readTrashAuto();
  keepDays.value = setting.days;
  if (!setting.enabled) return;
  const removed = await runTrashAutoClean();
  if (removed) ui.toast(`已按保留 ${setting.days} 天自动清理 ${removed} 条`, 3200);
}

/**
 * 恢复。
 *
 * 整条恢复不问 —— 那是用户点「恢复」时本来就想干的事。
 * **子项**单独恢复才问：一篇被删的笔记带着附件一起回去，用户不一定知道，问一句更稳妥。
 */
async function askRestore(node: TrashEntry | TrashChild, entry: TrashEntry, top: boolean): Promise<void> {
  menuEntry.value = null;
  if (!top && node.kind === 'note' && (await trashNoteHasAssets(node.path))) {
    assetsTarget.value = { node, entry };
    return;
  }
  await runRestore(node, entry, top);
}

async function runRestore(node: TrashEntry | TrashChild, entry: TrashEntry, top: boolean): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (top) await restoreTrashEntry(entry);
    else await restoreTrashChild(entry, node as TrashChild);
    assetsTarget.value = null;
    ui.toast('已恢复');
    await load();
  } catch (err) {
    ui.toast(err instanceof DavError ? err.message : '恢复失败');
  } finally {
    busy.value = false;
  }
}

function askPurge(node: TrashEntry | TrashChild, entry: TrashEntry, top: boolean): void {
  menuEntry.value = null;
  purgeTarget.value = { node, entry, top };
}

async function runPurge(): Promise<void> {
  const target = purgeTarget.value;
  if (!target || busy.value) return;
  busy.value = true;
  try {
    if (target.top) await purgeTrashEntry(target.entry);
    else await purgeTrashChild(target.node as TrashChild);
    purgeTarget.value = null;
    ui.toast('已彻底删除');
    await load();
  } catch {
    ui.toast('删除失败');
  } finally {
    busy.value = false;
  }
}

/** 顶层笔记：点标题进详情（已删的笔记也能看，正文还在 .trash 里） */
function openEntry(entry: TrashEntry): void {
  menuEntry.value = null;
  void router.push(`/notes/${encodeId(entry.path)}`);
}

/** 附件确认框点「同意」 */
function confirmAssets(): void {
  const target = assetsTarget.value;
  if (target) void runRestore(target.node, target.entry, false);
}

onMounted(async () => {
  await cleanExpired();
  await load();
});

/** 缓存层在后台校验出云端有更新，列表跟着刷一次 */
watch(() => sync.dataVersion, load);

const purgeLabel = (): string => {
  const target = purgeTarget.value;
  if (!target) return '';
  if (!target.top) return `「${(target.node as TrashChild).title}」`;
  return target.entry.kind === 'folder'
    ? `「${target.entry.title}」整个文件夹及其中的全部内容`
    : `「${target.entry.title}」`;
};
</script>

<template>
  <div class="page page-full">
    <AppHeader :crumbs="[{ label: '回收站' }]" back back-to="/settings" />

    <div class="page-body">
      <EmptyState v-if="loading" loading title="加载中" />

      <EmptyState v-else-if="!entries.length" title="回收站是空的" hint="删除笔记后会先进入这里，随时可以恢复">
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

      <p v-else class="lead">
        共 {{ entries.length }} 条删除记录，保留 {{ keepDays }} 天后自动清理。删掉的文件夹在这里是整条，
        展开后可以单独恢复里面的某一项。
      </p>

      <div v-if="!loading && entries.length" class="stack">
        <TrashNode
          v-for="entry in entries"
          :key="entry.entry"
          :node="entry"
          :entry="entry"
          top
          :depth="0"
          :busy="busy"
          @restore="askRestore"
          @purge="askPurge"
          @open="openEntry"
          @menu="menuEntry = $event"
        />
      </div>
    </div>

    <!-- 贴内容列的底部弹层（与列表页的笔记菜单同一形态） -->
    <Teleport to="body">
      <Transition name="sheet">
        <div v-if="menuEntry" class="sheet-mask" @click.self="menuEntry = null">
          <div class="sheet glass">
            <p class="sheet-title">
              {{ menuEntry.kind === 'folder' ? '📁 ' : '' }}{{ menuEntry.title }}
            </p>
            <button
              type="button"
              class="sheet-item"
              :disabled="busy"
              @click="askRestore(menuEntry, menuEntry, true)"
            >
              恢复
            </button>
            <button
              type="button"
              class="sheet-item is-danger"
              :disabled="busy"
              @click="askPurge(menuEntry, menuEntry, true)"
            >
              彻底删除
            </button>
            <button type="button" class="sheet-item is-cancel" @click="menuEntry = null">取消</button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <AppDialog
      :open="Boolean(assetsTarget)"
      title="这篇笔记有附件"
      confirm-label="同意"
      :busy="busy"
      @close="assetsTarget = null"
      @confirm="confirmAssets"
    >
      <p class="tip">该笔记有关联附件，将一同被恢复，是否同意？</p>
    </AppDialog>

    <AppDialog
      :open="Boolean(purgeTarget)"
      title="彻底删除？"
      confirm-label="彻底删除"
      danger
      :busy="busy"
      @close="purgeTarget = null"
      @confirm="runPurge"
    >
      <p class="tip">{{ purgeLabel() }}将被从你的网盘里永久删除，无法恢复。</p>
    </AppDialog>
  </div>
</template>

<style scoped>
.lead {
  margin-bottom: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--text-2);
}


</style>
