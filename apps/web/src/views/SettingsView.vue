<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { notesApi } from '@/storage/notes';
import { isTauriRuntime } from '@/storage/transport';
import {
  TRASH_DAYS_MAX,
  TRASH_DAYS_MIN,
  readTrashAuto,
  writeTrashAuto,
  type TrashAutoSetting,
} from '@/services/trash-auto';
import { appVersion, checkUpdate, installUpdate, type UpdateState } from '@/updater';
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

const displayName = computed(() => webdav.account || '未连接');
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase() || 'D');

const updateText = computed(() => {
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

async function onInstall(): Promise<void> {
  try {
    await installUpdate((state) => (updateState.value = state));
  } catch (error) {
    updateState.value = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

onMounted(async () => {
  version.value = await appVersion();
  try {
    trashCount.value = (await notesApi.list({ trash: true, limit: 1 })).total;
  } catch {
    // 统计失败不影响设置项本身
  }
});

async function onDisconnect(): Promise<void> {
  signingOut.value = true;
  await webdav.disconnect();
  ui.toast('已断开连接');
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
          <p class="meta mono">同步目录 {{ webdav.root }}</p>
          <p class="meta">笔记只存在你自己的网盘里</p>
        </div>
      </section>

      <p class="section-title">内容</p>
      <button type="button" class="tile" @click="router.push('/trash')">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M6 7.5h12M9.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 6v1.5M8 7.5l.6 10A1.5 1.5 0 0 0 10.1 19h3.8a1.5 1.5 0 0 0 1.5-1.5l.6-10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="tile-main">
          <span class="tile-name">回收站</span>
          <span class="tile-sub">恢复或彻底删除已删笔记</span>
        </span>
        <span class="tile-tail mono">{{ trashCount ?? '—' }}</span>
      </button>

      <p class="section-title">回收站自动清理</p>
      <div class="card-plain">
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
      </div>
      <p v-if="sync.fallback" class="hint">
        安装目录不可写，缓存已放到应用数据目录，不影响使用。
      </p>

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
        :disabled="checking || updateState?.kind === 'downloading' || updateState?.kind === 'installing'"
        @click="updateState?.kind === 'available' ? onInstall() : onCheckUpdate()"
      >
        {{
          checking
            ? '检查中…'
            : updateState?.kind === 'available'
              ? '立即更新并重启'
              : '检查更新'
        }}
      </button>

      <button class="logout" type="button" :disabled="signingOut" @click="onDisconnect">
        {{ signingOut ? '正在断开…' : '断开连接' }}
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
