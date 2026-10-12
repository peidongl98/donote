/**
 * 多选态。只保存三件事：在不在多选、选了谁、在哪一类列表里选。
 *
 * 具体操作（删除 / 移动 / 恢复 / 彻底删除）**不在这里**，由各视图交给
 * `BatchToolbar` 调 `services/batch`。这样 store 保持成一个纯状态容器，
 * 也不需要为了「笔记列表 / 文件夹 / 回收站」三套操作各写一遍分支。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type SelectionContext = 'notes' | 'folders' | 'trash';

export const useSelectionStore = defineStore('selection', () => {
  const mode = ref<'idle' | 'selecting'>('idle');
  const context = ref<SelectionContext>('notes');
  /** 每次改动都换一个新 Set：Vue 靠引用变化触发更新 */
  const selectedIds = ref<Set<string>>(new Set());

  const selecting = computed(() => mode.value === 'selecting');
  const count = computed(() => selectedIds.value.size);
  const ids = computed(() => [...selectedIds.value]);

  function enterSelecting(next: SelectionContext): void {
    context.value = next;
    mode.value = 'selecting';
    selectedIds.value = new Set();
  }

  function exitSelecting(): void {
    mode.value = 'idle';
    selectedIds.value = new Set();
  }

  function toggle(id: string): void {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function selectAll(all: string[]): void {
    selectedIds.value = new Set(all);
  }

  function clear(): void {
    selectedIds.value = new Set();
  }

  /**
   * 只留仍然存在的 id。批量操作跑完之后列表会刷新，
   * 已经不在列表里的（被删掉、被移走的）要从选中集合里摘出去，
   * 否则工具栏会显示一个点不动的「已选 3 项」。
   */
  function retain(alive: string[]): void {
    const keep = new Set(alive);
    selectedIds.value = new Set([...selectedIds.value].filter((id) => keep.has(id)));
  }

  function has(id: string): boolean {
    return selectedIds.value.has(id);
  }

  return {
    mode,
    context,
    selectedIds,
    selecting,
    count,
    ids,
    enterSelecting,
    exitSelecting,
    toggle,
    selectAll,
    clear,
    retain,
    has,
  };
});
