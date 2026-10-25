<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { notesApi } from '@/storage/notes';
import { requestBudget } from '@/storage/gate';
import { isTauriRuntime } from '@/storage/transport';
import {
  TRASH_DAYS_MAX,
  TRASH_DAYS_MIN,
  readTrashAuto,
  writeTrashAuto,
  type TrashAutoSetting,
} from '@/services/trash-auto';
import { appVersion, applyUpdate, autoState, checkUpdate, ensureUpdateReady, type UpdateState } from '@/updater';
import { invoke } from '@tauri-apps/api/core';
import { openLocalDir } from '@/services/storage/local';
import { useWebdavStore } from '@/stores/webdav';
import { useSyncStore } from '@/stores/sync';
import { useUiStore } from '@/stores/ui';
import { formatTime, relativeTime } from '@/utils/format';
import AppHeader from '@/components/AppHeader.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

const webdav = useWebdavStore();
const sync = useSyncStore();
const ui = useUiStore();
const router = useRouter();

const trashCount = ref<number | null>(null);
const signingOut = ref(false);
const syncing = ref(false);

/**
 * 请求预算：最近 30 分钟发出去了多少次同步请求。
 *
 * 坚果云免费版是 600 次 / 30 分钟，超了直接 503。这个数字以前拿不到 ——
 * 同类应用被抱怨最多的就是「不知道额度用在哪」，所以摆出来让它可见。
 * 每 5 秒刷一次即可（计数在内存里，没有额外请求）。
 */
const budget = ref(requestBudget());
let budgetTimer: ReturnType<typeof setInterval> | null = null;

/** 回收站自动清理（本机偏好，存 localStorage） */
const trashAuto = ref<TrashAutoSetting>(readTrashAuto());
const daysMin = TRASH_DAYS_MIN;
const daysMax = TRASH_DAYS_MAX;

function toggleTrashAuto(): void {
  trashAuto.value = writeTrashAuto({ enabled: !trashAuto.value.enabled });
}

function bumpDays(delta: number): void {
  const days = trashAuto.value.days + delta;
  if (days < TRASH_DAYS_MIN || days > TRASH_DAYS_MAX) return;
  trashAuto.value = writeTrashAuto({ days });
}

const lastCheck = computed(() =>
  trashAuto.value.checkedAt
    ? `${formatTime(trashAuto.value.checkedAt)}（${relativeTime(trashAuto.value.checkedAt)}）`
    : '还没检查过',
);

const desktop = isTauriRuntime();
const version = ref('');
const updateState = ref<UpdateState | null>(null);
const checking = ref(false);

async function onOpenCacheDir(): Promise<void> {
  try {
    await sync.openDir();
  } catch (error) {
    ui.toast(error instanceof Error ? error.message : String(error));
  }
}

async function onSyncNow(): Promise<void> {
  syncing.value = true;
  try {
    await sync.syncNow();
    ui.toast('同步完成');
  } finally {
    syncing.value = false;
  }
}

async function onResolve(path: string, keep: 'local' | 'remote'): Promise<void> {
  const item = sync.conflicts.find((entry) => entry.path === path);
  if (!item) return;
  await sync.resolve(item, keep);
  ui.toast(keep === 'local' ? '已用本地版本覆盖云端' : '已用云端版本覆盖本地');
}

const displayName = computed(() => {
  if (webdav.isLocal) return '本地模式';
  return webdav.account || '未连接';
});
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase() || 'D');

/** 自动流程的状态优先：它才是「正在下载 / 已就绪」的实况 */
const updateText = computed(() => {
  const auto = autoState.value;
  if (auto.kind === 'downloading') return `正在后台下载 ${auto.percent}%`;
  if (auto.kind === 'ready') {
    return auto.portable ? `有新版本 ${auto.version}（绿色版到下载页取新包）` : `新版本 ${auto.version} 已下载好`;
  }

  const state = updateState.value;
  switch (state?.kind) {
    case 'available':
      return `有新版本 ${state.version}`;
    case 'downloading':
      return `正在下载 ${state.percent}%`;
    case 'installing':
      return '正在安装…';
    case 'latest':
      return '已是最新版本';
    case 'error':
      return '检查更新失败';
    case 'unsupported':
      return '网页版不支持应用内更新';
    default:
      return '检查是否有新版本';
  }
});

const updateBusy = computed(
  () => checking.value || autoState.value.kind === 'downloading' || updateState.value?.kind === 'installing',
);

const updateActionLabel = computed(() => {
  const auto = autoState.value;
  if (auto.kind === 'downloading') return `下载中 ${auto.percent}%`;
  if (auto.kind === 'ready') return auto.portable ? '打开下载页取新包' : '重启以更新';
  if (checking.value) return '检查中…';
  if (updateState.value?.kind === 'available') return '立即更新并重启';
  return '检查更新';
});

async function onCheckUpdate(): Promise<void> {
  checking.value = true;
  updateState.value = null;
  try {
    const state = await checkUpdate();
    updateState.value = state;
    if (state.kind === 'latest') ui.toast('已是最新版本');
    if (state.kind === 'error') ui.toast(state.message);
  } finally {
    checking.value = false;
  }
}

/** 一个按钮两种时机：已下载好就装，否则先查（缺包时顺手补下） */
async function onUpdateAction(): Promise<void> {
  const auto = autoState.value;
  if (auto.kind === 'downloading') return;
  if (auto.kind === 'ready') {
    try {
      await applyUpdate();
    } catch (error) {
      ui.toast(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (updateState.value?.kind === 'available') {
    try {
      await ensureUpdateReady();
      await applyUpdate();
    } catch (error) {
      updateState.value = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    return;
  }
  await onCheckUpdate();
}

onMounted(async () => {
  version.value = await appVersion();
  try {
    trashCount.value = (await notesApi.list({ trash: true, limit: 1 })).total;
  } catch {
    // 统计失败不影响设置项本身
  }
  budgetTimer = setInterval(() => (budget.value = requestBudget()), 5000);
});

onUnmounted(() => {
  if (budgetTimer) clearInterval(budgetTimer);
  budgetTimer = null;
});

const localKindText = computed(() => {
  const kind = webdav.localInfo?.kind;
  if (kind === 'portable') return '绿色版：跟着软件所在目录';
  if (kind === 'documents') return '安装版：文档/DoNote';
  if (kind === 'appdata') return '应用数据目录（回落位置）';
  if (kind === 'idb') return '浏览器本地库';
  return '—';
});

/** 随安装包附带的《配置说明》：交给系统默认阅读器打开 */
async function onOpenGuide(): Promise<void> {
  try {
    await invoke('open_guide');
  } catch {
    ui.toast('打不开这份说明，可以到安装目录的 resources 文件夹里手动打开 DoNote-Guide.pdf');
  }
}

async function onOpenLocalDir(): Promise<void> {
  try {
    await openLocalDir();
  } catch {
    ui.toast('打不开这个目录，可以在上面那行路径里手动去找');
  }
}

async function onDisconnect(): Promise<void> {
  signingOut.value = true;
  await webdav.disconnect();
  ui.toast(webdav.isLocal ? '已退出本地模式' : '已断开连接');
  await router.replace({ name: 'login' });
}
</script>

<template>
  <div class="page">
    <AppHeader :crumbs="[{ label: '设置' }]" />

    <div class="page-body">
      <section class="card-plain profile">
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
        <div class="profile-main">
          <p class="name">{{ displayName }}</p>
          <template v-if="webdav.isLocal">
            <p class="meta mono" :title="webdav.localInfo?.dir">
              本地位置 {{ webdav.localInfo?.dir || '—' }}
            </p>
            <p class="meta">笔记只存在这台电脑上，不连任何服务器</p>
          </template>
          <template v-else>
            <p class="meta mono">同步目录 {{ webdav.root }}</p>
            <p class="meta">笔记只存在你自己的网盘里</p>
          </template>
        </div>
      </section>

      <!--
        这里原来还有一个「回收站」磁贴，点进 /trash。侧栏已经有同一个入口了，
        设置页再放一个等于让同一个页面有两个门 —— 去掉，只留下面这个自动清理。
      -->
      <p class="section-title">回收站自动清理</p>
      <div class="card-plain">
        <div class="line">
          <span class="line-key">回收站里</span>
          <span class="line-val mono">{{ trashCount ?? '—' }} 条</span>
        </div>
        <div class="line">
          <span class="line-key">自动清理</span>
          <button
            class="switch"
            type="button"
            role="switch"
            :aria-checked="trashAuto.enabled"
            aria-label="回收站自动清理"
            @click="toggleTrashAuto"
          >
            <span class="knob" />
          </button>
        </div>
        <div class="line">
          <span class="line-key">保留天数</span>
          <span class="stepper">
            <button
              type="button"
              aria-label="减少一天"
              :disabled="!trashAuto.enabled || trashAuto.days <= daysMin"
              @click="bumpDays(-1)"
            >
              −
            </button>
            <span class="mono days">{{ trashAuto.enabled ? trashAuto.days : '—' }}</span>
            <button
              type="button"
              aria-label="增加一天"
              :disabled="!trashAuto.enabled || trashAuto.days >= daysMax"
              @click="bumpDays(1)"
            >
              +
            </button>
          </span>
        </div>
        <div class="line">
          <span class="line-key">下次清理</span>
          <span class="line-val">{{ trashAuto.enabled ? '打开应用或打开回收站时' : '已关闭' }}</span>
        </div>
        <div class="line">
          <span class="line-key">上次检查</span>
          <span class="line-val">{{ lastCheck }}</span>
        </div>
      </div>
      <p class="hint">
        到期按整条删除（删文件夹时整棵子树算一条），不会留下半截；网盘被限流时这次跳过，下次触发接着清。
      </p>

      <!-- 本地模式：自己是原件，没有缓存层可讲，改成「文件在哪、怎么打开」 -->
      <template v-if="webdav.isLocal">
        <p class="section-title">本地笔记</p>
        <div class="card-plain">
          <p class="line">
            <span class="line-key">位置</span>
            <span class="line-val mono" :title="webdav.localInfo?.dir">{{ webdav.localInfo?.dir || '—' }}</span>
          </p>
          <p class="line">
            <span class="line-key">落点</span>
            <span class="line-val">{{ localKindText }}</span>
          </p>
        </div>
        <p class="hint">
          笔记就是这一层目录里的 .md 文件，可以直接备份、拷走、用别的编辑器打开。
          绿色版放在软件所在目录，安装版放在「文档」下；卸载软件不会动这里的文件。
        </p>
        <p v-if="webdav.localInfo?.fallback" class="hint">
          预期位置不可写，已回落到应用数据目录，不影响使用。
        </p>
        <button v-if="desktop" class="secondary" type="button" @click="onOpenLocalDir">打开这个文件夹</button>
      </template>

      <template v-else>
        <p class="section-title">本地缓存</p>
        <div class="card-plain">
          <p class="line">
            <span class="line-key">状态</span>
            <span class="line-val">{{ sync.usable ? sync.label : '未连接' }}</span>
          </p>
          <p class="line">
            <span class="line-key">缓存目录</span>
            <span class="line-val mono" :title="sync.dir">{{ sync.dir || '—' }}</span>
          </p>
          <p class="line">
            <span class="line-key">同步请求</span>
            <span class="line-val mono">{{ budget.used }} / {{ budget.limit }}</span>
          </p>
        </div>
        <p class="hint">
          同步请求是最近 30 分钟发出的次数。坚果云免费版每 30 分钟 600 次，超了会被临时限流；
          DoNote 已把所有请求排成一条队、每个至少隔 3.2 秒，正常用不会撞上。
        </p>
        <p v-if="sync.fallback" class="hint">
          安装目录不可写，缓存已放到应用数据目录，不影响使用。
        </p>
      </template>

      <div v-if="sync.conflicts.length" class="conflicts">
        <p class="conflict-title">以下几篇云端比本地新，选一个版本</p>
        <div v-for="item in sync.conflicts" :key="item.path" class="conflict">
          <span class="conflict-path mono">{{ item.path }}</span>
          <span class="conflict-actions">
            <button type="button" @click="onResolve(item.path, 'local')">保留本地</button>
            <button type="button" @click="onResolve(item.path, 'remote')">用云端</button>
          </span>
        </div>
      </div>

      <div class="row-btns">
        <button class="secondary" type="button" :disabled="!sync.usable" @click="onOpenCacheDir">
          打开缓存目录
        </button>
        <button class="secondary" type="button" :disabled="!sync.usable || syncing" @click="onSyncNow">
          {{ syncing ? '同步中…' : '立即同步' }}
        </button>
      </div>

      <p class="section-title">外观</p>
      <div class="tile as-row">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M12 4v16" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M12 20a8 8 0 0 0 0-16Z" fill="currentColor" />
          </svg>
        </span>
        <span class="tile-main">
          <span class="tile-name">主题</span>
          <span class="tile-sub">默认跟随系统，可手动覆盖</span>
        </span>
        <ThemeToggle />
      </div>

      <template v-if="!webdav.isLocal">
        <p class="section-title">WebDAV</p>
        <div class="card-plain">
          <p class="line">
            <span class="line-key">服务器</span>
            <span class="line-val mono">{{ webdav.baseUrl }}</span>
          </p>
          <p class="line">
            <span class="line-key">账号</span>
            <span class="line-val mono">{{ webdav.account || '—' }}</span>
          </p>
          <p class="line">
            <span class="line-key">同步目录</span>
            <span class="line-val mono">{{ webdav.root }}</span>
          </p>
        </div>
      </template>

      <p class="section-title">关于</p>
      <div class="card-plain">
        <p class="line">
          <span class="line-key">版本</span>
          <span class="line-val mono">{{ version || '—' }}</span>
        </p>
        <p class="line">
          <span class="line-key">更新</span>
          <span class="line-val">{{ updateText }}</span>
        </p>
      </div>

      <button
        v-if="desktop"
        class="secondary"
        type="button"
        :disabled="updateBusy"
        @click="onUpdateAction()"
      >
        {{ updateActionLabel }}
      </button>

      <!-- 配置说明：本地模式放哪、坚果云/群晖/威联通/Windows 共享盘怎么开，全在里面 -->
      <button v-if="desktop" class="secondary" type="button" @click="onOpenGuide">
        打开配置说明（PDF）
      </button>

      <button class="logout" type="button" :disabled="signingOut" @click="onDisconnect">
        {{ signingOut ? '正在退出…' : webdav.isLocal ? '退出本地模式' : '断开连接' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.profile {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 18px;
  font-weight: 650;
  flex: none;
}

.profile-main {
  min-width: 0;
}

.name {
  font-size: 17px;
  font-weight: 620;
}

.meta {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile {
  margin-bottom: var(--sp-1);
}

.tile.as-row {
  cursor: default;
}

.tile.as-row:hover {
  transform: none;
}

.tile-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent);
  flex: none;
}

.tile-tail {
  flex: none;
  font-size: 13px;
  color: var(--text-2);
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px 0;
}

.line + .line {
  border-top: 1px solid var(--divider);
}

.line-key {
  font-size: 13px;
  color: var(--text-2);
  flex: none;
}

.line-val {
  font-size: 13px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 开关：轨道 + 圆点。用 aria-checked 驱动，无障碍与样式同一个信号 */
.switch {
  position: relative;
  width: 46px;
  height: 28px;
  border-radius: var(--r-pill);
  background: var(--surface-border);
  flex: none;
  transition: background-color var(--dur) var(--ease-smooth);
}

.switch[aria-checked='true'] {
  background: var(--accent);
}

.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: var(--r-pill);
  background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease-spring);
}

.switch[aria-checked='true'] .knob {
  transform: translateX(18px);
}

.stepper {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.stepper button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-xs);
  font-size: 16px;
  line-height: 1;
  color: var(--accent);
  background: var(--accent-soft);
  transition: opacity var(--dur-fast) var(--ease-smooth);
}

.stepper button:disabled {
  opacity: 0.35;
}

.days {
  min-width: 26px;
  text-align: center;
  font-size: 14px;
}

.secondary {
  margin-top: var(--sp-2);
  width: 100%;
  height: 48px;
  border-radius: var(--r-md);
  color: var(--accent);
  background: var(--accent-soft);
  transition:
    background-color var(--dur) var(--ease-smooth),
    transform var(--dur-fast) var(--ease-spring);
}

/* 两个按钮并排时不要各自再撑满整行 */
.row-btns {
  display: flex;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
}

.row-btns .secondary {
  margin-top: 0;
}

.hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
}

.conflicts {
  margin-top: var(--sp-2);
}

.conflict-title {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.conflict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 8px 0;
}

.conflict + .conflict {
  border-top: 1px solid var(--divider);
}

.conflict-path {
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conflict-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.conflict-actions button {
  padding: 4px 10px;
  border-radius: var(--r-xs);
  font-size: 12px;
  color: var(--accent);
  background: var(--accent-soft);
}

.secondary:hover:not(:disabled) {
  transform: translateY(-1px);
}

.secondary:active:not(:disabled) {
  transform: scale(0.97);
}

.secondary:disabled {
  opacity: 0.6;
}

.logout {
  margin-top: var(--sp-2);
  width: 100%;
  height: 48px;
  border-radius: var(--r-md);
  color: var(--text-2);
  border: 1px solid var(--surface-border);
  transition:
    color var(--dur) var(--ease-smooth),
    border-color var(--dur) var(--ease-smooth),
    transform var(--dur-fast) var(--ease-spring);
}

.logout:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.logout:active:not(:disabled) {
  transform: scale(0.97);
}
</style>
