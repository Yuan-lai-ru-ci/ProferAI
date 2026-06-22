import Database from 'better-sqlite3'
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD, DEFAULT_CREDIT_GRANT } from './config.js'
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
try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0") } catch (_) {}

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

// 渠道表（服务端统一管理 API 渠道）
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    base_url TEXT DEFAULT '',
    models_json TEXT DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

// 额度表
db.exec(`
  CREATE TABLE IF NOT EXISTS credits (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    lifetime_consumed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)

// 额度交易流水表
db.exec(`
  CREATE TABLE IF NOT EXISTS credit_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT DEFAULT '',
    reference_type TEXT DEFAULT '',
    reference_id TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_ct_user ON credit_transactions(user_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_ct_created ON credit_transactions(created_at)')

// ===== 初始化 admin 账户 =====
export function initAdmin() {
  const existingAdmin = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(ADMIN_EMAIL)
  if (!existingAdmin) {
    if (!ADMIN_PASSWORD) {
      console.warn('[初始化] ADMIN_PASSWORD 环境变量未设置，生成随机密码...')
    }
    const pwd = ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex')
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(uuidv4(), ADMIN_EMAIL, hashPassword(pwd), 'Admin', Date.now())
    console.log(`[初始化] 已创建 admin 账户: ${ADMIN_EMAIL}`)
    if (!ADMIN_PASSWORD) {
      console.warn(`[安全] 随机密码: ${pwd}（请保存，或通过 ADMIN_PASSWORD 环境变量指定）`)
    }
  } else if (!existingAdmin.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(ADMIN_EMAIL)
    console.log(`[初始化] 已将 ${ADMIN_EMAIL} 提升为管理员`)
  }
  // 确保 admin 有 credits 行（向前兼容旧部署）
  const adminRow = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL)
  if (adminRow) {
    const existingCredits = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(adminRow.id)
    if (!existingCredits) {
      db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)').run(adminRow.id, DEFAULT_CREDIT_GRANT, Date.now())
      db.prepare("INSERT INTO credit_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, 'grant', ?, ?)").run(uuidv4(), adminRow.id, DEFAULT_CREDIT_GRANT, '管理员初始额度', Date.now())
      console.log(`[初始化] 已为 admin 创建额度: ${DEFAULT_CREDIT_GRANT}`)
    }
  }
}

// ===== Admin 用户管理 =====
export function listAllUsers({ search = '', page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit
  const searchClause = search ? 'WHERE u.email LIKE ? OR u.display_name LIKE ?' : ''
  const searchParam = search ? `%${search}%` : ''
  const countSql = `SELECT COUNT(*) as total FROM users u ${searchClause}`
  const dataSql = `
    SELECT u.id, u.email, u.display_name, u.avatar, u.is_admin, u.is_suspended,
           u.created_at, u.failed_login_attempts, u.locked_until,
           COALESCE(c.balance, 0) as credit_balance,
           COALESCE(c.lifetime_consumed, 0) as lifetime_consumed
    FROM users u
    LEFT JOIN credits c ON c.user_id = u.id
    ${searchClause}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `
  const total = search
    ? db.prepare(countSql).get(searchParam, searchParam).total
    : db.prepare(countSql).get().total
  const rows = search
    ? db.prepare(dataSql).all(searchParam, searchParam, limit, offset)
    : db.prepare(dataSql).all(limit, offset)
  return { users: rows, total, page, limit }
}

export function getUserById(userId) {
  return db.prepare(`
    SELECT u.*, COALESCE(c.balance, 0) as credit_balance,
           COALESCE(c.lifetime_consumed, 0) as lifetime_consumed
    FROM users u
    LEFT JOIN credits c ON c.user_id = u.id
    WHERE u.id = ?
  `).get(userId)
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email)
}

export function updateUser(userId, fields) {
  const allowed = ['display_name', 'is_suspended', 'is_admin']
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v) }
  }
  if (!sets.length) return null
  vals.push(userId)
  return db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function promoteUser(userId) {
  return db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId)
}

export function demoteUser(userId) {
  return db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(userId)
}

// ===== 渠道管理 =====
export function listAllChannels() {
  return db.prepare('SELECT * FROM channels ORDER BY created_at DESC').all()
}

export function listActiveChannels() {
  return db.prepare('SELECT * FROM channels WHERE is_active = 1 ORDER BY created_at DESC').all()
}

export function getChannelById(id) {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
}

export function createChannel({ id, name, provider, apiKeyEncrypted, baseUrl, modelsJson, createdBy }) {
  const now = Date.now()
  return db.prepare(`
    INSERT INTO channels (id, name, provider, api_key_encrypted, base_url, models_json, is_active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, name, provider, apiKeyEncrypted, baseUrl || '', modelsJson || '[]', createdBy || '', now, now)
}

export function updateChannel(id, fields) {
  const allowed = ['name', 'provider', 'api_key_encrypted', 'base_url', 'models_json', 'is_active']
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v) }
  }
  if (!sets.length) return null
  sets.push('updated_at = ?'); vals.push(Date.now())
  vals.push(id)
  return db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function softDeleteChannel(id) {
  return db.prepare('UPDATE channels SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

// ===== 额度管理 =====
export function getCredits(userId) {
  return db.prepare('SELECT * FROM credits WHERE user_id = ?').get(userId)
}

export function ensureCreditRow(userId) {
  const existing = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(userId)
  if (!existing) {
    const now = Date.now()
    db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)').run(userId, DEFAULT_CREDIT_GRANT, now)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, 'grant', ?, ?)`)
      .run(uuidv4(), userId, DEFAULT_CREDIT_GRANT, '新用户注册赠送额度', now)
  }
}

export function grantCredits(adminUserId, targetUserId, amount, description) {
  const now = Date.now()
  const tx = db.transaction(() => {
    ensureCreditRow(targetUserId)
    db.prepare('UPDATE credits SET balance = balance + ?, updated_at = ? WHERE user_id = ?').run(amount, now, targetUserId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'grant', ?, 'admin_grant', ?, ?)`)
      .run(uuidv4(), targetUserId, amount, description || '', adminUserId, now)
  })
  tx()
}

// 并发锁 — 防止同一用户并发扣减导致超扣
const creditLocks = new Map()
function withCreditLock(userId, fn) {
  if (creditLocks.has(userId)) {
    // 已有锁，改用排队等待
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!creditLocks.has(userId)) {
          creditLocks.set(userId, true)
          try { const r = fn(); resolve(r) } catch (e) { reject(e) } finally { creditLocks.delete(userId) }
        } else { setImmediate(check) }
      }
      setImmediate(check)
    })
  }
  creditLocks.set(userId, true)
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(r => { creditLocks.delete(userId); return r }, e => { creditLocks.delete(userId); throw e })
    }
    return result
  } finally {
    creditLocks.delete(userId)
  }
}

export function deductCredits(userId, amount, { description, referenceType, referenceId } = {}) {
  const now = Date.now()
  const deduct = db.transaction(() => {
    // 使用 SELECT ... FOR UPDATE 等价：先锁住行
    db.pragma('busy_timeout = 5000')
    const row = db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(userId)
    if (!row || row.balance < amount) {
      throw new Error(`INSUFFICIENT_CREDITS:${row ? row.balance : 0}`)
    }
    db.prepare('UPDATE credits SET balance = balance - ?, lifetime_consumed = lifetime_consumed + ?, updated_at = ? WHERE user_id = ?')
      .run(amount, amount, now, userId)
    const txId = uuidv4()
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'consumption', ?, ?, ?, ?)`)
      .run(txId, userId, -amount, description || '', referenceType || '', referenceId || '', now)
    return txId
  })
  return withCreditLock(userId, () => deduct())
}

export function getCreditTransactions({ userId, type, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit
  let where = 'WHERE 1=1'
  const params = []
  if (userId) { where += ' AND ct.user_id = ?'; params.push(userId) }
  if (type) { where += ' AND ct.type = ?'; params.push(type) }
  const countSql = `SELECT COUNT(*) as total FROM credit_transactions ct ${where}`
  const dataSql = `
    SELECT ct.*, u.email as user_email, u.display_name as user_name
    FROM credit_transactions ct
    LEFT JOIN users u ON u.id = ct.user_id
    ${where}
    ORDER BY ct.created_at DESC
    LIMIT ? OFFSET ?
  `
  const total = db.prepare(countSql).get(...params).total
  const rows = db.prepare(dataSql).all(...params, limit, offset)
  return { transactions: rows, total, page, limit }
}

export function getCreditSummary() {
  return db.prepare(`
    SELECT
      COUNT(DISTINCT c.user_id) as users_with_credits,
      COALESCE(SUM(c.balance), 0) as total_balance,
      COALESCE(SUM(c.lifetime_consumed), 0) as total_consumed,
      COALESCE(SUM(CASE WHEN ct.created_at > ? THEN ABS(ct.amount) ELSE 0 END), 0) as consumed_this_month
    FROM credits c
    LEFT JOIN credit_transactions ct ON ct.user_id = c.user_id
  `).get(Date.now() - 30 * 86400 * 1000)
}

// ===== 仪表盘统计 =====
export function getDashboardStats() {
  const now = Date.now()
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const monthStart = now - 30 * 86400 * 1000

  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count
  const activeToday = db.prepare(
    `SELECT COUNT(DISTINCT user_id) as count FROM workspace_members WHERE last_seen_at > ?`
  ).get(todayStart).count
  const activeChannels = db.prepare('SELECT COUNT(*) as count FROM channels WHERE is_active = 1').get().count
  const totalWorkspaces = db.prepare('SELECT COUNT(*) as count FROM workspaces WHERE is_deleted = 0').get().count

  const creditSummary = getCreditSummary()

  const topUsers = db.prepare(`
    SELECT u.id, u.email, u.display_name, COALESCE(c.lifetime_consumed, 0) as consumed
    FROM users u
    LEFT JOIN credits c ON c.user_id = u.id
    ORDER BY consumed DESC
    LIMIT 10
  `).all()

  return {
    totalUsers, activeToday, activeChannels, totalWorkspaces,
    totalBalance: creditSummary.total_balance,
    totalConsumed: creditSummary.total_consumed,
    consumedThisMonth: creditSummary.consumed_this_month,
    topUsers
  }
}
