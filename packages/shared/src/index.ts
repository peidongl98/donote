/**
 * 前端与桌面壳共享的类型与常量。
 * 该包不走构建：main/types/exports 直接指向 TS 源码。
 *
 * ⚠️ BYOS 架构（数据存用户自己的坚果云）下没有服务端，这里只保留笔记与文件夹的数据形状。
 */

/* ------------------------------ 笔记 ------------------------------ */

export interface NoteDTO {
  id: string;
  folder_id: string | null;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  version: number;
  /** frontmatter 里的 tags，没有就是空数组 */
  tags: string[];
}

/** 列表项不含正文，只带摘要 */
export interface NoteSummaryDTO {
  id: string;
  folder_id: string | null;
  title: string;
  excerpt: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  /** 来自摘要缓存（后台补齐时顺手解析的 frontmatter） */
  tags: string[];
  /**
   * 层级路径（`框架笔记 / 子笔记B`），在顶层则是空串。
   * 搜索结果与卡片上用它回答「这篇在哪」——同名笔记一眼分得清。
   */
  path_label: string;
}

export interface NoteListResult {
  items: NoteSummaryDTO[];
  total: number;
  limit: number;
  offset: number;
}

/* ----------------------------- 文件夹 ----------------------------- */

export interface FolderDTO {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: number;
  updated_at: number;
  /** 直系笔记数（不含子文件夹）；带 index.md 的子目录算 1 篇 */
  note_count: number;
  /**
   * 目录里有 index.md 时，该目录是一个**页面**，这里是那篇笔记的 id（= `目录/index.md` 的
   * base64url）；没有 index.md 的目录是纯文件夹，值为 null。
   *
   * 用「一个字段」而不是给节点分基类：扁平清单已被 8 个视图消费，加一个可空字段
   * 只影响侧栏与文件夹页两处，见 docs/index-md-design.md §3.1。
   */
  page_id: string | null;
}

export const NOTE_LIMITS = {
  /** 单篇笔记正文上限（字符） */
  maxContent: 200_000,
  maxTitle: 200,
  maxFolderName: 60,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;
