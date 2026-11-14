/**
 * 拖放落点：把屏幕上的一个点换算成侧栏树里的目标目录。
 *
 * 三个来源共用这一份判定 —— 侧栏内部拖动节点、桌面端 Tauri 拖入文件、浏览器拖入文件。
 * 判定只看 DOM 上的三个 data 属性，不依赖树的业务数据，所以 SidebarTree 怎么渲染都行：
 *
 * - `data-drop-key`    这一行的标识（内部拖动时拿它和源行比对，也是高亮的键）
 * - `data-drop-folder` 目标目录的 id（空串 = 同步根，也就是「未归类」）
 * - `data-drop-kind`   folder / note / root，只用来决定提示文案
 *
 * 行与树容器都带：树容器代表「根目录」（拖到行下方空白 = 移出到未归类）。行与行之间
 * 没有缝隙 —— `.tree-row` 带 1px 透明下边框，命中区是连续的，不会误判成根。
 */
import { reactive } from 'vue';

export interface DropPoint {
  key: string;
  /** 目标目录 id；null = 同步根 */
  folderId: string | null;
  kind: 'folder' | 'note' | 'root';
  /** 落点那一行显示的名字，用于「放到 X」这类提示 */
  label: string;
}

/** 侧栏把当前落点画成高亮；拖动结束后必须清掉 */
export const dropHover = reactive<{ key: string | null }>({ key: null });

export function setDropHover(key: string | null): void {
  dropHover.key = key;
}

/**
 * 点 → 落点。命中行本身或行内任何子元素都算，取最近的 `[data-drop-key]`。
 * 坐标非法或不在任何行上返回 null（调用方据此走「没有指定位置」的老路）。
 */
export function resolveDropPoint(x: number, y: number): DropPoint | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-key]');
  if (!hit) return null;
  const raw = hit.dataset.dropFolder ?? '';
  return {
    key: hit.dataset.dropKey ?? '',
    folderId: raw || null,
    kind:
      hit.dataset.dropKind === 'root'
        ? 'root'
        : hit.dataset.dropKind === 'note'
          ? 'note'
          : 'folder',
    label: hit.dataset.dropLabel ?? '',
  };
}
