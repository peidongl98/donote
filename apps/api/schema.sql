-- DoNote D1 schema
-- 多租户从第一天做：所有业务表带 tenant_id，查询恒带 WHERE tenant_id = ?
-- 时间统一 INTEGER（毫秒时间戳）。软删除 = deleted_at 可空。
-- 幂等：全部 IF NOT EXISTS，可重复执行。

-- ------------------------------ 用户与租户 ------------------------------

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  nickname TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ------------------------------ 认证 ------------------------------
-- phone_codes 比任务书原 schema 多一列 locked_until：
-- 「连续错 3 次锁定 10 分钟」需要一个不与 expires_at 语义混用的独立信号。
-- 用负值 attempts 或复用 expires_at 表达锁定都会造成单字段双语义，故独立成列。

CREATE TABLE IF NOT EXISTS phone_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------ 内容 ------------------------------

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  folder_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_folders_tenant ON folders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

-- 分享行不随笔记软删除而删除：软删除期间分享页统一 410 Gone，
-- 未来做版本历史时可直接复用旧 slug；仅笔记彻底删除时才级联清掉。

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  password TEXT,
  expires_at INTEGER,
  view_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id)
);
CREATE INDEX IF NOT EXISTS idx_shares_slug ON shares(slug);
CREATE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id);

-- ------------------------------ 审计与限流 ------------------------------

CREATE TABLE IF NOT EXISTS sms_logs (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  ip TEXT,
  success INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_phone_time ON sms_logs(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_ip_time ON sms_logs(ip, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at);
