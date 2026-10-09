import {
  NOTE_LIMITS,
  RESOURCE_ROUTES,
  type FolderDTO,
  type NoteDTO,
  type NoteListResult,
  type PublicShareDTO,
  type ShareDTO,
} from '@donote/shared';
import { apiRequest } from './client';

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface NoteListQuery {
  /** 省略 = 全部；'root' = 未归类；其它 = 文件夹 id */
  folder_id?: string;
  q?: string;
  trash?: boolean;
  limit?: number;
  offset?: number;
}

export const notesApi = {
  list(query: NoteListQuery = {}) {
    return apiRequest<NoteListResult>(
      RESOURCE_ROUTES.notes +
        qs({
          folder_id: query.folder_id,
          q: query.q,
          trash: query.trash ? 1 : undefined,
          limit: query.limit ?? NOTE_LIMITS.defaultPageSize,
          offset: query.offset,
        }),
    );
  },
  create(input: { title?: string; content?: string; folder_id?: string | null }) {
    return apiRequest<{ note: NoteDTO }>(RESOURCE_ROUTES.notes, { method: 'POST', body: input });
  },
  get(id: string) {
    return apiRequest<{ note: NoteDTO }>(`${RESOURCE_ROUTES.notes}/${id}`);
  },
  update(id: string, patch: { title?: string; content?: string; folder_id?: string | null }) {
    return apiRequest<{ note: NoteDTO | null }>(`${RESOURCE_ROUTES.notes}/${id}`, {
      method: 'PATCH',
      body: patch,
    });
  },
  /** hard=true 为彻底删除（不可恢复），默认只进回收站 */
  remove(id: string, hard = false) {
    return apiRequest<{ hard: boolean }>(
      `${RESOURCE_ROUTES.notes}/${id}${hard ? '?hard=1' : ''}`,
      { method: 'DELETE' },
    );
  },
  restore(id: string) {
    return apiRequest(`${RESOURCE_ROUTES.notes}/${id}/restore`, { method: 'POST' });
  },
};

export const foldersApi = {
  list() {
    return apiRequest<{ items: FolderDTO[] }>(RESOURCE_ROUTES.folders);
  },
  create(input: { name: string; parent_id?: string | null }) {
    return apiRequest<{ folder: FolderDTO }>(RESOURCE_ROUTES.folders, {
      method: 'POST',
      body: input,
    });
  },
  rename(id: string, name: string) {
    return apiRequest<{ folder: FolderDTO }>(`${RESOURCE_ROUTES.folders}/${id}`, {
      method: 'PATCH',
      body: { name },
    });
  },
  /** 删除只移除文件夹本身，其中内容上移到父级 */
  remove(id: string) {
    return apiRequest<{ moved_to: string | null }>(`${RESOURCE_ROUTES.folders}/${id}`, {
      method: 'DELETE',
    });
  },
};

export interface ShareListItem extends ShareDTO {
  note_deleted: boolean;
  expired: boolean;
}

export const sharesApi = {
  create(input: { note_id: string; password?: string; expires_in_days?: number | null }) {
    return apiRequest<{ share: ShareDTO }>(RESOURCE_ROUTES.shares, { method: 'POST', body: input });
  },
  list() {
    return apiRequest<{ items: ShareListItem[] }>(RESOURCE_ROUTES.shares);
  },
  remove(id: string) {
    return apiRequest(`${RESOURCE_ROUTES.shares}/${id}`, { method: 'DELETE' });
  },
};

/** 公开接口：不带 Authorization */
export const publicApi = {
  share(slug: string) {
    return apiRequest<PublicShareDTO>(`${RESOURCE_ROUTES.publicShares}/${slug}`, {
      anonymous: true,
    });
  },
  shareWithPassword(slug: string, password: string) {
    return apiRequest<PublicShareDTO>(`${RESOURCE_ROUTES.publicShares}/${slug}`, {
      method: 'POST',
      body: { password },
      anonymous: true,
    });
  },
};

/** 分享链接用 slug 而非 id，公开页地址稳定 */
export function shareUrl(slug: string): string {
  return `${window.location.origin}/s/${slug}`;
}
