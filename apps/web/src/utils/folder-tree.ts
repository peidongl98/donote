/**
 * 文件夹列表的两项纯计算：拉平成带层级的行、挑出能当目标的行。
 *
 * 「移动到…」的单条 UI（`FoldersView`）与批量移动（`BatchToolbar`）共用同一套规则 ——
 * 数据层 `foldersApi.move` 另有同样的拒绝逻辑，这里只是不把死路摆到用户面前。
 */
import type { FolderDTO } from '@donote/shared';
import { decodeId } from '@/storage/notes';

export interface FolderRow {
  folder: FolderDTO;
  depth: number;
  /** 有没有直系子文件夹 —— 有才画折叠箭头，没有的用等宽占位保持名字对齐 */
  hasChildren: boolean;
}

/**
 * 按 parent_id 组树后再拉平，带缩进层级。
 *
 * 传 `expanded` 就只铺开其中已展开的那些层（「文件夹」页的折叠）；
 * 不传则是整棵树 —— 「移动到…」的候选清单要一次看全，不能跟着页面的折叠状态走。
 */
export function flattenFolders(folders: FolderDTO[], expanded?: ReadonlySet<string>): FolderRow[] {
  const byParent = new Map<string | null, FolderDTO[]>();
  for (const f of folders) {
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f);
    byParent.set(f.parent_id, list);
  }
  const out: FolderRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const f of byParent.get(parent) ?? []) {
      const children = byParent.get(f.id) ?? [];
      out.push({ folder: f, depth, hasChildren: children.length > 0 });
      if (!expanded || expanded.has(f.id)) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * 排掉一组「自己」以及它们各自的整棵子树。
 * 单条移动传一个 id，批量移动传选中的全部 id —— 同一段逻辑。
 */
export function pickableFolders(folders: FolderDTO[], excludeIds: string[]): FolderRow[] {
  const banned = excludeIds.map(decodeId).filter(Boolean);
  if (!banned.length) return flattenFolders(folders);
  return flattenFolders(folders).filter(({ folder }) => {
    const path = decodeId(folder.id);
    return !banned.some((b) => path === b || path.startsWith(`${b}/`));
  });
}
