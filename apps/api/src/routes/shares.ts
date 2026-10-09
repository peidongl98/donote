import { Hono } from 'hono';
import type { AppEnv, ShareRow } from '../env';
import { requireSession } from '../middleware/session';
import { newId, randomHex, sha256Hex } from '../utils/id';
import { ApiException, ok } from '../utils/response';

interface ShareJoinRow {
  id: string;
  note_id: string;
  tenant_id: string;
  slug: string;
  password: string | null;
  expires_at: number | null;
  view_count: number;
  created_at: number;
  title: string;
  content: string;
  note_updated_at: number;
  deleted_at: number | null;
}

const MAX_EXPIRE_DAYS = 365;

/* --------------------------- 登录态：分享管理 --------------------------- */

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.use('*', requireSession);

async function uniqueSlug(db: D1Database): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const slug = randomHex(8);
    const exists = await db.prepare('SELECT id FROM shares WHERE slug = ?').bind(slug).first();
    if (!exists) return slug;
  }
  throw new ApiException('internal', '生成分享链接失败，请重试', 500);
}

/**
 * POST /api/v1/shares
 * 同一篇笔记重复分享时复用已有链接，避免一个笔记散出多条 URL。
 */
shareRoutes.post('/', async (c) => {
  const { tenantId } = c.get('auth');
  const body = await c.req
    .json<{ note_id?: unknown; password?: unknown; expires_in_days?: unknown }>()
    .catch(() => null);

  const noteId = typeof body?.note_id === 'string' ? body.note_id.trim() : '';
  if (!noteId) throw new ApiException('invalid_payload', '缺少 note_id', 400);

  const note = await c.env.DB.prepare(
    'SELECT id, title FROM notes WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
  )
    .bind(noteId, tenantId)
    .first<{ id: string; title: string }>();
  if (!note) throw new ApiException('not_found', '笔记不存在或已删除', 404);

  const passwordRaw = typeof body?.password === 'string' ? body.password.trim() : '';
  const password = passwordRaw ? await sha256Hex(passwordRaw) : null;

  let expiresAt: number | null = null;
  if (body?.expires_in_days !== undefined && body.expires_in_days !== null) {
    const days = Number(body.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRE_DAYS) {
      throw new ApiException('invalid_payload', `有效期需在 1–${MAX_EXPIRE_DAYS} 天之间`, 400);
    }
    expiresAt = Date.now() + days * 86_400_000;
  }

  const existing = await c.env.DB.prepare(
    'SELECT * FROM shares WHERE note_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(noteId, tenantId)
    .first<ShareRow>();

  const now = Date.now();
  if (existing) {
    // 复用同一条：只更新密码与有效期，slug 不变（已发出去的链接继续有效）
    await c.env.DB.prepare('UPDATE shares SET password = ?, expires_at = ? WHERE id = ?')
      .bind(password, expiresAt, existing.id)
      .run();
    return ok(c, {
      share: toShareDTO({ ...existing, password, expires_at: expiresAt }, note.title),
    });
  }

  const id = newId('shr');
  const slug = await uniqueSlug(c.env.DB);
  await c.env.DB.prepare(
    `INSERT INTO shares (id, note_id, tenant_id, slug, password, expires_at, view_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, noteId, tenantId, slug, password, expiresAt, now)
    .run();

  return ok(c, {
    share: toShareDTO(
      { id, note_id: noteId, tenant_id: tenantId, slug, password, expires_at: expiresAt, view_count: 0, created_at: now },
      note.title,
    ),
  });
});

/** GET /api/v1/shares —— 我的全部分享 */
shareRoutes.get('/', async (c) => {
  const { tenantId } = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, n.title, n.deleted_at
       FROM shares s JOIN notes n ON n.id = s.note_id
      WHERE s.tenant_id = ?
      ORDER BY s.created_at DESC`,
  )
    .bind(tenantId)
    .all<ShareJoinRow>();

  return ok(c, {
    items: results.map((row) => ({
      ...toShareDTO(row, row.title),
      note_deleted: row.deleted_at !== null,
      expired: row.expires_at !== null && row.expires_at <= Date.now(),
    })),
  });
});

/** DELETE /api/v1/shares/:id —— 撤销分享（行即删，访客立刻拿到 404） */
shareRoutes.delete('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const result = await c.env.DB.prepare('DELETE FROM shares WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), tenantId)
    .run();
  if (!result.meta.changes) throw new ApiException('not_found', '分享不存在', 404);
  return ok(c, {});
});

function toShareDTO(row: ShareRow, noteTitle: string) {
  return {
    id: row.id,
    note_id: row.note_id,
    note_title: noteTitle,
    slug: row.slug,
    has_password: row.password !== null,
    expires_at: row.expires_at,
    view_count: row.view_count,
    created_at: row.created_at,
  };
}

/* --------------------------- 匿名：公开分享页 --------------------------- */

export const publicShareRoutes = new Hono<AppEnv>();

/** 取分享内容，并按「不存在 / 已删 / 过期」给出 404 或 410 */
async function loadShare(db: D1Database, slug: string): Promise<ShareJoinRow> {
  const row = await db
    .prepare(
      `SELECT s.*, n.title, n.content, n.updated_at AS note_updated_at, n.deleted_at
         FROM shares s JOIN notes n ON n.id = s.note_id
        WHERE s.slug = ?`,
    )
    .bind(slug)
    .first<ShareJoinRow>();

  if (!row) throw new ApiException('not_found', '分享不存在或已撤销', 404);
  if (row.deleted_at !== null) throw new ApiException('gone', '内容已删除', 410);
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    throw new ApiException('gone', '分享链接已过期', 410);
  }
  return row;
}

async function bumpViewCount(db: D1Database, slug: string): Promise<void> {
  await db.prepare('UPDATE shares SET view_count = view_count + 1 WHERE slug = ?').bind(slug).run();
}

/** GET /api/v1/public/shares/:slug */
publicShareRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await loadShare(c.env.DB, slug);

  if (row.password !== null) {
    throw new ApiException('password_required', '该分享需要密码', 401);
  }
  await bumpViewCount(c.env.DB, slug);
  return ok(c, { slug, title: row.title, content: row.content, updated_at: row.note_updated_at });
});

/** POST /api/v1/public/shares/:slug —— 提交密码换内容 */
publicShareRoutes.post('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await loadShare(c.env.DB, slug);
  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const input = typeof body?.password === 'string' ? body.password.trim() : '';

  if (row.password === null) {
    await bumpViewCount(c.env.DB, slug);
    return ok(c, { slug, title: row.title, content: row.content, updated_at: row.note_updated_at });
  }
  if (!input) throw new ApiException('password_required', '请输入访问密码', 401);

  const hashed = await sha256Hex(input);
  if (hashed !== row.password) {
    throw new ApiException('unauthorized', '密码不正确', 401);
  }

  await bumpViewCount(c.env.DB, slug);
  return ok(c, { slug, title: row.title, content: row.content, updated_at: row.note_updated_at });
});
