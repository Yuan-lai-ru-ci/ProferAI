import Database from 'better-sqlite3'
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD } from './config.js'
import { hashPassword } from './utils.js'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// ===== 数据库初始化 =====
export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '🧑‍💻',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'team',
    brand TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    inviter_id TEXT NOT NULL,
    invitee_email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );

  CREATE TABLE IF NOT EXISTS sync_envelopes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );

  CREATE TABLE IF NOT EXISTS file_manifests (
    workspace_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    is_directory INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    modified_at INTEGER NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (workspace_id, file_path),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );
`)

// 安全添加列（忽略已存在的情况）
try { db.exec("ALTER TABLE file_manifests ADD COLUMN uploaded_by TEXT NOT NULL DEFAULT ''") } catch (_) {}
try { db.exec("ALTER TABLE file_manifests ADD COLUMN uploaded_by_name TEXT NOT NULL DEFAULT ''") } catch (_) {}
try { db.exec("ALTER TABLE workspace_members ADD COLUMN last_seen_at INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN locked_until INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN refresh_token TEXT DEFAULT NULL") } catch (_) {}

// token 黑名单表
db.exec(`
  CREATE TABLE IF NOT EXISTS token_blacklist (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`)

// 审计日志表
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT,
    user_id TEXT,
    user_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_logs(workspace_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at)')

// ===== 初始化 admin 账户 =====
export function initAdmin() {
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL)
  if (!existingAdmin) {
    if (!ADMIN_PASSWORD) {
      console.warn('[初始化] ADMIN_PASSWORD 环境变量未设置，生成随机密码...')
    }
    const pwd = ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex')
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), ADMIN_EMAIL, hashPassword(pwd), 'Admin', Date.now())
    console.log(`[初始化] 已创建 admin 账户: ${ADMIN_EMAIL}`)
    if (!ADMIN_PASSWORD) {
      console.warn(`[安全] 随机密码: ${pwd}（请保存，或通过 ADMIN_PASSWORD 环境变量指定）`)
    }
  }
}
