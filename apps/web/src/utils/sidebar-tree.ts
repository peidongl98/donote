/**
 * 侧栏树形导航的纯计算部分。
 *
 * 数据层给的是两份**扁平**清单（`FolderDTO[]` 带 `parent_id`、`NoteSummaryDTO[]` 带 `folder_id`），
 * 这里只做归堆与拉平，不碰网络、不持有状态 —— 与 `utils/folder-tree.ts` 同一路数。
 *
 * 侧栏要的渲染顺序：同一层里**先文件夹、后笔记**（与 /folders 页一致），
 * 名字按中文拼音序（`localeCompare(..., 'zh')`）。
 */
import type { FolderDTO, NoteSummaryDTO } from '@donote/shared';

export interface SidebarFolderRow {
  kind: 'folder';
  depth: number;
  folder: FolderDTO;
  /**
   * 目录里有 index.md 时，这里是那篇**页面**笔记的 id（该目录本身是一个页面）；
   * 纯文件夹是 null。侧栏据此决定这一行是 📄 还是 📁、点它去哪、给哪些菜单项。
   */
  pageId: string | null;
  /** 还有下一层可展开（子文件夹或笔记）。没有就不给展开箭头，免得点了没反应 */
  hasChildren: boolean;
  expanded: boolean;
}

export interface SidebarNoteRow {
  kind: 'note';
  depth: number;
  note: NoteSummaryDTO;
}

export type SidebarRow = SidebarFolderRow | SidebarNoteRow;

/** 顶层用的桶键。base64url 编出来的 id 不会是空串，不会撞 */
const ROOT = '';

/** 按某个 key 归堆，key 为 null 的归到顶层 */
function bucket<T>(items: T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item) ?? ROOT;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function byName<T>(items: T[], nameOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh'));
}

/**
 * 把两份扁平清单拉成「按展开状态剪枝后的行清单」。
 *
 * `expanded` 里没有的文件夹只出自己这一行，其子项不出 —— 所以折叠态下不渲染后代，
 * 也不需要递归判断可见性。
 */
export function buildSidebarRows(
  folders: FolderDTO[],
  notes: NoteSummaryDTO[],
  expanded: Set<string>,
): SidebarRow[] {
  /**
   * 页面（目录里有 index.md）在侧栏由**它的目录行**代表：那一行渲染成 📄 并链到那篇笔记。
   * 数据层的列表里页面也是一条笔记（列表页与搜索要看得到它），所以这里必须把它从笔记桶里
   * 剔掉 —— 否则同一条东西在树上出现两次，而且目录的「展开箭头」会指向一行点不出来的东西。
   */
  const pageIds = new Set(
    folders.map((folder) => folder.page_id).filter((id): id is string => id !== null),
  );

  const foldersByParent = bucket(folders, (folder) => folder.parent_id);
  const notesByFolder = bucket(
    notes.filter((note) => !pageIds.has(note.id)),
    (note) => note.folder_id,
  );
  const rows: SidebarRow[] = [];
  const emitted = new Set<string>();

  const walk = (parent: string, depth: number): void => {
    for (const folder of byName(foldersByParent.get(parent) ?? [], (item) => item.name)) {
      if (emitted.has(folder.id)) continue; // 防环：网盘不可能有环，但截断的数据可能自指
      emitted.add(folder.id);
      const children =
        (foldersByParent.get(folder.id)?.length ?? 0) +
        (notesByFolder.get(folder.id)?.length ?? 0);
      const open = expanded.has(folder.id);
      rows.push({
        kind: 'folder',
        depth,
        folder,
        pageId: folder.page_id,
        hasChildren: children > 0,
        expanded: open,
      });
      if (open) walk(folder.id, depth + 1);
    }
    for (const note of byName(notesByFolder.get(parent) ?? [], (item) => item.title)) {
      rows.push({ kind: 'note', depth, note });
    }
  };

  walk(ROOT, 0);

  /**
   * `walkTree` 有 MAX_DIRS = 300 的上限，超了会把某些目录截断在外面 ——
   * 那种情况下「某个文件夹的父节点根本没被列出来」，只从根走会把它整棵漏掉。
   * 兜底：把这种真孤儿挂到顶层再走一遍（`walk` 会跳过已出的行，
   * 所以它自己的子项照样按展开状态出）。宁可位置不准，也不能让它从侧栏里消失。
   *
   * ⚠️ 判据必须是「父节点在不在清单里」，不能是「有没有被 emitted」——
   * 被折叠起来的子目录同样没 emitted，那样会把整棵树一次性掀开。
   */
  const known = new Set(folders.map((folder) => folder.id));
  const orphans = folders.filter((folder) => folder.parent_id && !known.has(folder.parent_id));
  if (orphans.length) {
    foldersByParent.set(ROOT, [...(foldersByParent.get(ROOT) ?? []), ...orphans]);
    walk(ROOT, 0);
  }

  return rows;
}

/**
 * 某条笔记的祖先文件夹链（从最外层往里），用来一进笔记详情就把路径展开 ——
 * 否则「当前笔记高亮」在折叠态下根本看不见（高亮的东西没渲染）。
 * 数据层已经给了 `folder_id`，逐级往上问父节点即可，不用扫整棵树。
 */
export function ancestorFolderIds(folders: FolderDTO[], folderId: string | null): string[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const chain: string[] = [];
  let cursor: string | null = folderId;
  // 自指/环的护栏：目录层级本身也有 MAX_DEPTH = 8
  for (let guard = 0; cursor && guard < 64; guard++) {
    const folder = byId.get(cursor);
    if (!folder) break;
    chain.unshift(folder.id);
    cursor = folder.parent_id;
  }
  return chain;
}
