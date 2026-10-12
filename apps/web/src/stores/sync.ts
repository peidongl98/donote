/**
 * 同步状态。界面上的那一个点、以及冲突清单都由它出。
 *
 * 三态：
 *   online   绿 —— 连着，且没有待推的改动
 *   pending  黄 —— 有本地改动没推上去，或存在冲突
 *   offline  灰 —— 连不上，正在用本地缓存
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CachedStorage } from '@/services/cache/cached-adapter';
import { BackgroundWork } from '@/services/cache/background';
import { cacheStore } from '@/services/cache/store';
import { decodeId, notesApi } from '@/storage/notes';

export interface Conflict {
  path: string;
  localMtime: number;
  remoteMtime: number;
}

export const useSyncStore = defineStore('sync', () => {
  const cache = ref<CachedStorage | null>(null);
  const work = ref<BackgroundWork | null>(null);
  const offline = ref(false);
  const dirty = ref(0);
  const cached = ref(0);
  const conflicts = ref<Conflict[]>([]);
  const dir = ref('');
  const fallback = ref(false);
  /** 每次缓存层有变化就 +1，用来让下面那些 computed 重新算 */
  const version = ref(0);

  const usable = computed(() => cache.value !== null);

  const tone = computed<'online' | 'pending' | 'offline'>(() => {
    void version.value;
    if (conflicts.value.length || dirty.value) return 'pending';
    return offline.value ? 'offline' : 'online';
  });

  const label = computed(() => {
    void version.value;
    if (conflicts.value.length) return `有 ${conflicts.value.length} 篇内容冲突，需要你选一个版本`;
    if (dirty.value) return `有 ${dirty.value} 篇改动还没同步`;
    if (offline.value) return '连不上网盘，正在用本地缓存';
    return `已同步 · 本地已存 ${cached.value} 篇`;
  });

  function refresh(): void {
    const store = cache.value;
    if (!store) return;
    offline.value = store.isOffline();
    dirty.value = store.dirtyCount();
    cached.value = store.cachedCount();
    version.value++;
  }

  function attach(next: CachedStorage): void {
    if (cache.value) return;
    cache.value = next;
    next.subscribe(refresh);
    void cacheStore()
      .location()
      .then((info) => {
        if (info) {
          dir.value = info.dir;
          fallback.value = info.fallback;
        }
      })
      .catch(() => undefined);

    const worker = new BackgroundWork(next, {
      async listNotes() {
        const result = await notesApi.list({ limit: 100_000 });
        return result.items.map((item) => decodeId(item.id));
      },
      onConflict(path, localMtime, remoteMtime) {
        if (conflicts.value.some((item) => item.path === path)) return;
        conflicts.value = [...conflicts.value, { path, localMtime, remoteMtime }];
      },
    });
    work.value = worker;
    worker.start();
    refresh();
  }

  function detach(): void {
    work.value?.stop();
    work.value = null;
    cache.value = null;
    conflicts.value = [];
    offline.value = false;
    dirty.value = 0;
    cached.value = 0;
    version.value++;
  }

  /**
   * 这篇笔记有没有本地副本。列表里没副本的显示成浅灰。
   * 没有缓存层（浏览器）时一律返回 true —— 不画灰，免得给出假的离线承诺。
   */
  function hasCopy(id: string): boolean {
    void version.value;
    if (!cache.value) return true;
    return cache.value.hasCopy(decodeId(id));
  }

  async function openDir(): Promise<void> {
    await cacheStore().openDir();
  }

  async function syncNow(): Promise<void> {
    await work.value?.runNow();
    refresh();
  }

  /** 冲突处理：keep 决定用哪边的正文覆盖另一边 */
  async function resolve(conflict: Conflict, keep: 'local' | 'remote'): Promise<void> {
    const store = cache.value;
    if (!store) return;
    if (keep === 'local') await store.keepLocal(conflict.path);
    else await store.acceptRemote(conflict.path);
    conflicts.value = conflicts.value.filter((item) => item.path !== conflict.path);
    refresh();
  }

  return {
    usable,
    tone,
    label,
    offline,
    dirty,
    cached,
    conflicts,
    dir,
    fallback,
    attach,
    detach,
    hasCopy,
    openDir,
    syncNow,
    resolve,
    refresh,
  };
});
