import { Hono } from 'hono';
import { NOTE_LIMITS } from '@donote/shared';
import type { AppEnv, NoteRow, NoteSummaryRow } from '../env';
import { toNoteDTO, toNoteSummaryDTO } from '../env';
import { requireSession } from '../middleware/session';
import { newId } from '../utils/id';
import { ApiException, ok } from '../utils/response';

export const noteRoutes = new Hono<AppEnv>();

noteRoutes.use('*', requireSession);

/** 列表不取正文，只取前 120 字符做摘要 */
const SELECT_SUMMARY = `SELECT id, folder_id, title, substr(content, 1, 120) AS excerpt,
          created_at, updated_at, deleted_at
     FROM notes`;

const DEFAULT_TITLE = '无标题笔记';

function readTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, NOTE_LIMITS.maxTitle);
}

function readContent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > NOTE_LIMITS.maxContent) {
    throw new ApiException('invalid_payload', `正文超过 ${NOTE_LIMITS.maxContent} 字符上限`, 400);
  }
  return raw;
}

/** 文件夹必须属于同一租户，否则等于跨租户写入 */
async function assertFolderExists(
  db: D1Database,
  tenantId: string,
  folderId: string | null,
): Promise<void> {
  if (!folderId) return;
  const row = await db
    .prepare('SELECT id FROM folders WHERE id = ? AND tenant_id = ?')
    .bind(folderId, tenantId)
    .first();
  if (!row) throw new ApiException('invalid_payload', '目标文件夹不存在', 400);
}

function readFolderId(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v === '' || v === 'root' ? null : v;
}

/**
 * GET /api/v1/notes
 * query: folder_id(缺省=全部 | root | <id>)、q(关键词)、trash=1(回收站)、limit、offset
 */
noteRoutes.get('/', async (c) => {
  const { tenantId } = c.get('auth');
  const where: string[] = ['tenant_id = ?'];
  const binds: (string | number)[] = [tenantId];

  where.push(c.req.query('trash') === '1' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');

  const folderId = c.req.query('folder_id');
  if (folderId === 'root') {
    where.push('folder_id IS NULL');
  } else if (folderId) {
    where.push('folder_id = ?');
    binds.push(folderId);
  }

  const q = (c.req.query('q') ?? '').trim();
  if (q) {
    where.push('(title LIKE ? OR content LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }

  const rawLimit = Number(c.req.query('limit') ?? NOTE_LIMITS.defaultPageSize);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 0, 1), NOTE_LIMITS.maxPageSize);
  const rawOffset = Number(c.req.query('offset') ?? 0);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  const clause = where.join(' AND ');
  const [rows, count] = await c.env.DB.batch<NoteSummaryRow | { total: number }>([
    c.env.DB.prepare(
      `${SELECT_SUMMARY} WHERE ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM notes WHERE ${clause}`).bind(...binds),
  ]);

  const items = (rows.results as NoteSummaryRow[]).map(toNoteSummaryDTO);
  const total = (count.results[0] as { total: number } | undefined)?.total ?? items.length;

  return ok(c, { items, total, limit, offset });
});

/** POST /api/v1/notes */
noteRoutes.post('/', async (c) => {
  const { tenantId, userId } = c.get('auth');
  const body = await c.req.json<{ title?: unknown; content?: unknown; folder_id?: unknown }>().catch(() => null);

  const title = readTitle(body?.title) || DEFAULT_TITLE;
  const content = readContent(body?.content) ?? '';
  const folderId = readFolderId(body?.folder_id);
  await assertFolderExists(c.env.DB, tenantId, folderId);

  const now = Date.now();
  const id = newId('note');
  await c.env.DB.prepare(
    `INSERT INTO notes (id, tenant_id, user_id, folder_id, title, content, created_at, updated_at, deleted_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
  )
    .bind(id, tenantId, userId, folderId, title, content, now, now)
    .run();

  const row: NoteRow = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    folder_id: folderId,
    title,
    content,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    version: 1,
  };
  return ok(c, { note: toNoteDTO(row) });
});

/** GET /api/v1/notes/:id —— 回收站中的笔记也可读，便于前端展示「已删除」状态 */
noteRoutes.get('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const row = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), tenantId)
    .first<NoteRow>();
  if (!row) throw new ApiException('not_found', '笔记不存在', 404);
  return ok(c, { note: toNoteDTO(row) });
});

/** PATCH /api/v1/notes/:id —— 只更新请求里出现的字段，version 每次自增 */
noteRoutes.patch('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const id = c.req.param('id');
  const body = await c.req
    .json<{ title?: unknown; content?: unknown; folder_id?: unknown }>()
    .catch(() => null);
  if (!body) throw new ApiException('invalid_payload', '请求体格式不正确', 400);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if (body.title !== undefined) {
    sets.push('title = ?');
    binds.push(readTitle(body.title) || DEFAULT_TITLE);
  }
  if (body.content !== undefined) {
    sets.push('content = ?');
    binds.push(readContent(body.content) ?? '');
  }
  if (body.folder_id !== undefined) {
    const folderId = readFolderId(body.folder_id);
    await assertFolderExists(c.env.DB, tenantId, folderId);
    sets.push('folder_id = ?');
    binds.push(folderId);
  }
  if (sets.length === 0) {
    throw new ApiException('invalid_payload', '没有需要更新的字段', 400);
  }

  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}, updated_at = ?, version = version + 1
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  )
    .bind(...binds, now, id, tenantId)
    .run();

  if (!result.meta.changes) throw new ApiException('not_found', '笔记不存在或已被删除', 404);

  const row = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<NoteRow>();
  return ok(c, { note: row ? toNoteDTO(row) : null });
});

/**
 * DELETE /api/v1/notes/:id
 * 默认软删除（deleted_at），?hard=1 才彻底删除并级联清掉分享行。
 */
noteRoutes.delete('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const id = c.req.param('id');
  const now = Date.now();

  if (c.req.query('hard') === '1') {
    const exists = await c.env.DB.prepare('SELECT id FROM notes WHERE id = ? AND tenant_id = ?')
      .bind(id, tenantId)
      .first();
    if (!exists) throw new ApiException('not_found', '笔记不存在', 404);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM shares WHERE note_id = ? AND tenant_id = ?').bind(id, tenantId),
      c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND tenant_id = ?').bind(id, tenantId),
    ]);
    return ok(c, { hard: true });
  }

  const result = await c.env.DB.prepare(
    `UPDATE notes SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
  )
    .bind(now, now, id, tenantId)
    .run();
  if (!result.meta.changes) throw new ApiException('not_found', '笔记不存在或已在回收站', 404);

  // 软删除期间分享页统一 410：这里不动 shares 行，保留可恢复的余地
  return ok(c, { hard: false });
});

/** POST /api/v1/notes/:id/restore */
noteRoutes.post('/:id/restore', async (c) => {
  const { tenantId } = c.get('auth');
  const result = await c.env.DB.prepare(
    `UPDATE notes SET deleted_at = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`,
  )
    .bind(Date.now(), c.req.param('id'), tenantId)
    .run();
  if (!result.meta.changes) throw new ApiException('not_found', '笔记不在回收站中', 404);
  return ok(c, {});
});
