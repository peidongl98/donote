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
  /** 直系笔记数（不含子文件夹） */
  note_count: number;
}

export const NOTE_LIMITS = {
  /** 单篇笔记正文上限（字符） */
  maxContent: 200_000,
  maxTitle: 200,
  maxFolderName: 60,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;
