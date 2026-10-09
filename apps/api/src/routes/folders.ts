import { Hono } from 'hono';
import { NOTE_LIMITS } from '@donote/shared';
import type { AppEnv, FolderRow } from '../env';
import { toFolderDTO } from '../env';
import { requireSession } from '../middleware/session';
import { newId } from '../utils/id';
import { ApiException, ok } from '../utils/response';

export const folderRoutes = new Hono<AppEnv>();

folderRoutes.use('*', requireSession);

const SELECT_WITH_COUNT = `SELECT f.*,
         (SELECT COUNT(*) FROM notes n
           WHERE n.folder_id = f.id AND n.tenant_id = f.tenant_id AND n.deleted_at IS NULL) AS note_count
    FROM folders f`;

function readName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, NOTE_LIMITS.maxFolderName);
}

function readParentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v === '' || v === 'root' ? null : v;
}

async function assertParentExists(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  const row = await db
    .prepare('SELECT id FROM folders WHERE id = ? AND tenant_id = ?')
    .bind(parentId, tenantId)
    .first();
  if (!row) throw new ApiException('invalid_payload', '上级文件夹不存在', 400);
}

/**
 * 防成环：沿 parent 链上溯，遇到自己就说明目标在其子树内。
 * 带 visited 集合兜底，避免历史脏数据造成死循环。
 */
async function assertNoCycle(
  db: D1Database,
  tenantId: string,
  id: string,
  parentId: string | null,
): Promise<void> {
  let cursor = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === id) {
      throw new ApiException('conflict', '不能把文件夹移动到它自己的子文件夹下', 409);
    }
    if (visited.has(cursor)) return;
    visited.add(cursor);
    const row = await db
      .prepare('SELECT parent_id FROM folders WHERE id = ? AND tenant_id = ?')
      .bind(cursor, tenantId)
      .first<{ parent_id: string | null }>();
    cursor = row?.parent_id ?? null;
  }
}

/** GET /api/v1/folders —— 平铺返回，前端按 parent_id 自行组树 */
folderRoutes.get('/', async (c) => {
  const { tenantId } = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `${SELECT_WITH_COUNT} WHERE f.tenant_id = ? ORDER BY f.name ASC`,
  )
    .bind(tenantId)
    .all<FolderRow & { note_count: number }>();
  return ok(c, { items: results.map((row) => toFolderDTO(row, row.note_count)) });
});

/** POST /api/v1/folders */
folderRoutes.post('/', async (c) => {
  const { tenantId, userId } = c.get('auth');
  const body = await c.req.json<{ name?: unknown; parent_id?: unknown }>().catch(() => null);
  const name = readName(body?.name);
  if (!name) throw new ApiException('invalid_payload', '文件夹名称不能为空', 400);

  const parentId = readParentId(body?.parent_id);
  await assertParentExists(c.env.DB, tenantId, parentId);

  const now = Date.now();
  const id = newId('fld');
  await c.env.DB.prepare(
    `INSERT INTO folders (id, tenant_id, user_id, parent_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tenantId, userId, parentId, name, now, now)
    .run();

  const row: FolderRow = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    parent_id: parentId,
    name,
    created_at: now,
    updated_at: now,
  };
  return ok(c, { folder: toFolderDTO(row, 0) });
});

/** PATCH /api/v1/folders/:id */
folderRoutes.patch('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: unknown; parent_id?: unknown }>().catch(() => null);
  if (!body) throw new ApiException('invalid_payload', '请求体格式不正确', 400);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if (body.name !== undefined) {
    const name = readName(body.name);
    if (!name) throw new ApiException('invalid_payload', '文件夹名称不能为空', 400);
    sets.push('name = ?');
    binds.push(name);
  }
  if (body.parent_id !== undefined) {
    const parentId = readParentId(body.parent_id);
    await assertParentExists(c.env.DB, tenantId, parentId);
    await assertNoCycle(c.env.DB, tenantId, id, parentId);
    sets.push('parent_id = ?');
    binds.push(parentId);
  }
  if (sets.length === 0) {
    throw new ApiException('invalid_payload', '没有需要更新的字段', 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE folders SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND tenant_id = ?`,
  )
    .bind(...binds, Date.now(), id, tenantId)
    .run();
  if (!result.meta.changes) throw new ApiException('not_found', '文件夹不存在', 404);

  const row = await c.env.DB.prepare('SELECT * FROM folders WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<FolderRow>();
  return ok(c, { folder: row ? toFolderDTO(row, 0) : null });
});

/**
 * DELETE /api/v1/folders/:id
 * 只删文件夹本身：子文件夹与其中的笔记全部上移到被删文件夹的父级，不丢内容。
 */
folderRoutes.delete('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const id = c.req.param('id');
  const folder = await c.env.DB.prepare('SELECT * FROM folders WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<FolderRow>();
  if (!folder) throw new ApiException('not_found', '文件夹不存在', 404);

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE folders SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND tenant_id = ?',
    ).bind(folder.parent_id, now, id, tenantId),
    c.env.DB.prepare(
      'UPDATE notes SET folder_id = ?, updated_at = ? WHERE folder_id = ? AND tenant_id = ?',
    ).bind(folder.parent_id, now, id, tenantId),
    c.env.DB.prepare('DELETE FROM folders WHERE id = ? AND tenant_id = ?').bind(id, tenantId),
  ]);

  return ok(c, { moved_to: folder.parent_id });
});
