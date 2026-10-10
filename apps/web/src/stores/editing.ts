import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 「哪篇笔记正开着」的全局标记。
 *
 * 详情页进入时标记、离开时清除；列表 / 文件夹 / 回收站的动作菜单读它，
 * 命中同一条就把重命名 / 移动 / 删除禁掉 —— 避免一边在写、一边把这文件挪走。
 *
 * 单窗口下列表页与详情页是互斥路由，正常撞不上；这条规则真正起作用是在
 * 将来的分栏 / 多标签界面。
 */
export const useEditingStore = defineStore('editing', () => {
  const editingNoteId = ref<string | null>(null);

  function enter(id: string): void {
    editingNoteId.value = id;
  }

  /** 只清掉自己的标记，避免晚卸载的页面把新页面的标记抹掉 */
  function leave(id: string): void {
    if (editingNoteId.value === id) editingNoteId.value = null;
  }

  return { editingNoteId, enter, leave };
});
