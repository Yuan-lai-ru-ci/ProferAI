import Database from 'better-sqlite3'
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD, DEFAULT_CREDIT_GRANT, getAccountCapability } from './config.js'
import { hashPassword } from './utils.js'
import { buildRequestLogInsertSql, buildRequestLogValues } from './request-log-utils.js'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// ===== 数据库初始化 =====
export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
// 并发写入时最多等 5s 再报 SQLITE_BUSY（连接级，设一次即全局生效，
// 不需要在每个事务里重复设置）。
db.pragma('busy_timeout = 5000')

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
try { db.exec("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'team'") } catch (_) {}
// 长效 relay 令牌 — 客户端作为渠道 apiKey 长期持有，用于 /v1/proxy 鉴权（不随 1h accessToken 过期）
try { db.exec("ALTER TABLE users ADD COLUMN relay_token TEXT DEFAULT NULL") } catch (_) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_relay_token ON users(relay_token)") } catch (_) {}
// 自配 API 开关 — admin 可对任意用户单独开/关，与账号类型无关
try { db.exec("ALTER TABLE users ADD COLUMN can_self_config_api INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN restored_at INTEGER DEFAULT NULL") } catch (_) {}
// 文件搜索索引
db.exec('CREATE INDEX IF NOT EXISTS idx_file_manifests_file_name ON file_manifests(file_name)')
db.exec('CREATE INDEX IF NOT EXISTS idx_file_manifests_file_path ON file_manifests(file_path)')
// 同步信封序列号（替代 occurred_at 作为精确游标，解决同毫秒丢数据问题）
try { db.exec("ALTER TABLE sync_envelopes ADD COLUMN seq INTEGER DEFAULT 0") } catch (_) {}
db.exec('CREATE INDEX IF NOT EXISTS idx_sync_envelopes_ws_seq ON sync_envelopes(workspace_id, occurred_at, seq)')
// 回填已有信封的 seq（用 rowid 保证不重复）
try {
  db.exec("UPDATE sync_envelopes SET seq = rowid WHERE seq = 0")
} catch (_) {}
// 一次性回填：已有软删除但无 deleted_at 的工作区用 updated_at 补上
try {
  db.exec("UPDATE workspaces SET deleted_at = updated_at WHERE is_deleted = 1 AND deleted_at IS NULL")
} catch (_) {}

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
try { db.exec("ALTER TABLE channels ADD COLUMN agent_base_url TEXT DEFAULT ''") } catch (_) {}

// 请求日志表 — 记录每次 API 代理请求的详细信息
db.exec(`
  CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_credits INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1,
    stream INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_rl_user ON request_logs(user_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_rl_created ON request_logs(created_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_rl_model ON request_logs(model)')
try { db.exec('ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0') } catch (_) {}
try { db.exec('ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0') } catch (_) {}

// 激活码表 — 管理员生成，用于个人用户注册
db.exec(`
  CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    used_by TEXT DEFAULT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    used_at INTEGER DEFAULT NULL
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_ac_code ON activation_codes(code)')
try { db.exec("ALTER TABLE activation_codes ADD COLUMN account_type TEXT NOT NULL DEFAULT 'standard'") } catch (_) {}

// 模型价格表 — 区分输入/输出/缓存定价（credits / 1K tokens）
db.exec(`
  CREATE TABLE IF NOT EXISTS pricing (
    model TEXT PRIMARY KEY,
    input_rate REAL NOT NULL DEFAULT 1,
    output_rate REAL NOT NULL DEFAULT 3,
    cache_read_ratio REAL NOT NULL DEFAULT 0.1,
    updated_at INTEGER NOT NULL
  )
`)
try { db.exec("ALTER TABLE pricing ADD COLUMN cache_read_ratio REAL NOT NULL DEFAULT 0.1") } catch (_) {}
// 种子数据: [model, input_rate, output_rate, cache_read_ratio]
const DEFAULT_PRICING = [
  ['deepseek-v4-pro',  0.5, 2,   0.1],
  ['deepseek-v4-flash', 0.3, 1,  0.1],
  ['claude-sonnet-4-5', 5,   15, 0.1],
  ['claude-haiku-4-5',  1,   3,  0.1],
  ['gpt-5',            5,   15, 0.1],
  ['gpt-5-mini',       1,   2,  0.1],
  ['kimi-k2',          1,   3,  0.1],
]
const insertPricing = db.prepare('INSERT OR IGNORE INTO pricing (model, input_rate, output_rate, cache_read_ratio, updated_at) VALUES (?, ?, ?, ?, ?)')
for (const [model, input, output, cacheRatio] of DEFAULT_PRICING) {
  insertPricing.run(model, input, output, cacheRatio, Date.now())
}

// ===== 初始化 admin 账户 =====
export function initAdmin() {
  const existingAdmin = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(ADMIN_EMAIL)
  if (!existingAdmin) {
    if (!ADMIN_PASSWORD) {
      // 无预设密码时自动生成随机密码（仅首次）
      const pwd = crypto.randomBytes(16).toString('hex')
      console.warn('[初始化] ADMIN_PASSWORD 环境变量未设置，已生成随机密码。')
      console.warn('[安全] ⚠️  下面这行包含敏感信息，生产环境请用 ADMIN_PASSWORD 环境变量替代：')
      console.warn(`[安全] 临时密码: ${pwd}`)
      console.warn('[安全] ⚠️  请立即保存并修改密码，此消息仅在首次初始化时出现。')
      db.prepare(
        'INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      ).run(uuidv4(), ADMIN_EMAIL, hashPassword(pwd), 'Admin', Date.now())
      console.log(`[初始化] 已创建 admin 账户: ${ADMIN_EMAIL}`)
    } else {
      db.prepare(
        'INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      ).run(uuidv4(), ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD), 'Admin', Date.now())
      console.log(`[初始化] 已创建 admin 账户: ${ADMIN_EMAIL}`)
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
           u.account_type, u.can_self_config_api,
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
  const allowed = ['display_name', 'is_suspended', 'is_admin', 'account_type', 'can_self_config_api']
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

/** 彻底删除用户及其关联数据（额度/交易/日志/工作区成员关系） */
export function deleteUser(userId) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM credit_transactions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM credits WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM request_logs WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM token_blacklist WHERE token_hash IN (SELECT token_hash FROM token_blacklist WHERE 1=0)').run()
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })
  tx()
  return true
}

// ===== Relay 令牌（代管模式 proxy 鉴权用的长效令牌）=====

/** 生成一个带前缀的长效 relay 令牌（256 位熵） */
function generateRelayToken() {
  return `prelay_${crypto.randomBytes(32).toString('hex')}`
}

/**
 * 确保用户有 relay 令牌；没有则生成并持久化。
 * 返回明文令牌（仅服务端持有，下发给客户端作为渠道 apiKey）。
 */
export function ensureRelayToken(userId) {
  const row = db.prepare('SELECT relay_token FROM users WHERE id = ?').get(userId)
  if (row?.relay_token) return row.relay_token
  const token = generateRelayToken()
  db.prepare('UPDATE users SET relay_token = ? WHERE id = ?').run(token, userId)
  return token
}

/** 重新生成 relay 令牌（吊销旧令牌，旧的立即失效）。返回新令牌。 */
export function rotateRelayToken(userId) {
  const token = generateRelayToken()
  db.prepare('UPDATE users SET relay_token = ? WHERE id = ?').run(token, userId)
  return token
}

/** 按 relay 令牌反查用户（proxy 鉴权用）。返回 id/email/account_type/can_self_config_api 等。 */
export function getUserByRelayToken(token) {
  if (!token) return undefined
  return db.prepare('SELECT id, email, is_admin, is_suspended, account_type, can_self_config_api FROM users WHERE relay_token = ?').get(token)
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

export function createChannel({ id, name, provider, apiKeyEncrypted, baseUrl, agentBaseUrl, modelsJson, createdBy }) {
  const now = Date.now()
  return db.prepare(`
    INSERT INTO channels (id, name, provider, api_key_encrypted, base_url, agent_base_url, models_json, is_active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, name, provider, apiKeyEncrypted, baseUrl || '', agentBaseUrl || '', modelsJson || '[]', createdBy || '', now, now)
}

export function updateChannel(id, fields) {
  const allowed = ['name', 'provider', 'api_key_encrypted', 'base_url', 'agent_base_url', 'models_json', 'is_active']
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

export function hardDeleteChannel(id) {
  return db.prepare('DELETE FROM channels WHERE id = ?').run(id)
}

// ===== 额度管理 =====
export function getCredits(userId) {
  return db.prepare('SELECT * FROM credits WHERE user_id = ?').get(userId)
}

/** 确保用户有额度行。按 accountType 给差异化初始额度。 */
export function ensureCreditRow(userId, accountType = 'standard') {
  const existing = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(userId)
  if (!existing) {
    const grant = getAccountCapability(accountType).defaultCreditGrant
    const now = Date.now()
    db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)').run(userId, grant, now)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, 'grant', ?, ?)`)
      .run(uuidv4(), userId, grant, `注册赠送额度 (${accountType})`, now)
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

/** 退款：回退已扣额度并记录退款流水（事务保护） */
export function refundCredits(userId, amount, { description, referenceId } = {}) {
  const now = Date.now()
  const tx = db.transaction(() => {
    db.prepare('UPDATE credits SET balance = balance + ?, lifetime_consumed = MAX(0, lifetime_consumed - ?), updated_at = ? WHERE user_id = ?')
      .run(amount, amount, now, userId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'refund', ?, 'api_refund', ?, ?)`)
      .run(uuidv4(), userId, amount, description || '代理失败自动退款', referenceId || '', now)
  })
  tx()
}

// 并发锁 — 串行化同一用户的额度操作。
//
// 注意：better-sqlite3 的事务在 Node 单线程下本就是原子的，单个 deductCredits
// 调用不会被打断，因此这把锁对「纯同步事务」是冗余的。保留它的价值在于：
// 为未来可能插入异步步骤（如扣费前先 await 调用 new-api 校验额度）预留串行化能力，
// 确保同一用户的多个额度操作不会交错。当前为同步路径，开销可忽略。
const creditLocks = new Map()

/** 执行 fn 并自动管理锁的获取/释放，兼容同步和异步 fn */
function runWithLock(userId, fn) {
  creditLocks.set(userId, true)
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(
        r => { creditLocks.delete(userId); return r },
        e => { creditLocks.delete(userId); throw e }
      )
    }
    creditLocks.delete(userId)
    return result
  } catch (e) {
    creditLocks.delete(userId)
    throw e
  }
}

function withCreditLock(userId, fn) {
  if (creditLocks.has(userId)) {
    // 已有锁，排队等待
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (!creditLocks.has(userId)) {
          try {
            const r = runWithLock(userId, fn)
            if (r instanceof Promise) {
              r.then(resolve, reject)
            } else {
              resolve(r)
            }
          } catch (e) {
            reject(e)
          }
        } else {
          setImmediate(poll)
        }
      }
      setImmediate(poll)
    })
  }
  return runWithLock(userId, fn)
}

export function deductCredits(userId, amount, { description, referenceType, referenceId } = {}) {
  const now = Date.now()
  const deduct = db.transaction(() => {
    // better-sqlite3 事务在 Node 单线程下天然原子，busy_timeout 已在 DB 初始化时设置。
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
  const balance = db.prepare(`
    SELECT
      COUNT(DISTINCT c.user_id) as users_with_credits,
      COALESCE(SUM(c.balance), 0) as total_balance,
      COALESCE(SUM(c.lifetime_consumed), 0) as total_consumed
    FROM credits c
  `).get()
  const month = db.prepare(`
    SELECT MAX(0, COALESCE(SUM(CASE
      WHEN type = 'consumption' THEN -amount
      WHEN type = 'refund' THEN -amount
      ELSE 0
    END), 0)) as consumed_this_month
    FROM credit_transactions
    WHERE created_at > ? AND type IN ('consumption', 'refund')
  `).get(Date.now() - 30 * 86400 * 1000)
  return { ...balance, consumed_this_month: month.consumed_this_month }
}

// ===== 请求日志 =====

/** 记录一次 API 代理请求 */
export function logRequest(params) {
  return db.prepare(buildRequestLogInsertSql()).run(...buildRequestLogValues(params))
}

/** 根据实际用量调整已扣额度（正值=多退，负值=少补） */
export function adjustCreditDeduction(userId, oldAmount, newAmount, referenceId) {
  const diff = oldAmount - newAmount
  if (diff === 0) return
  const now = Date.now()
  const tx = db.transaction(() => {
    if (diff > 0) {
      // 多扣了，退还
      db.prepare('UPDATE credits SET balance = balance + ?, lifetime_consumed = MAX(0, lifetime_consumed - ?), updated_at = ? WHERE user_id = ?')
        .run(diff, diff, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'refund', ?, 'api_adjust', ?, ?)`)
        .run(uuidv4(), userId, diff, `实际用量调整：退还 ${diff} credits`, referenceId, now)
    } else {
      // 少扣了，补扣（不检查余额，用量已发生）
      const extra = -diff
      db.prepare('UPDATE credits SET balance = MAX(0, balance - ?), lifetime_consumed = lifetime_consumed + ?, updated_at = ? WHERE user_id = ?')
        .run(extra, extra, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'consumption', ?, 'api_adjust', ?, ?)`)
        .run(uuidv4(), userId, -extra, `实际用量调整：补扣 ${extra} credits`, referenceId, now)
    }
  })
  tx()
}

/** 获取用户请求日志 */
export function getRequestLogs({ userId, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit
  let where = 'WHERE 1=1'
  const params = []
  if (userId) { where += ' AND user_id = ?'; params.push(userId) }
  const total = db.prepare(`${usageLogsCte()} SELECT COUNT(*) as total FROM usage_logs ${where}`).get(...params).total
  const rows = db.prepare(`${usageLogsCte()} SELECT * FROM usage_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)
  return { logs: rows, total, page, limit }
}

function usageLogsCte() {
  // 计费已收敛到 New API，请求日志只读 request_logs（token 用量，cost 恒 0）。
  // 不再关联 credit_transactions（Profer 自有扣费已移除）。
  return `
    WITH usage_logs AS (
      SELECT id, user_id, model, provider, prompt_tokens, completion_tokens, total_tokens,
             cache_creation_tokens, cache_read_tokens, cost_credits, duration_ms, success,
             stream, error_message, created_at, 0 as historical
      FROM request_logs
    )
  `
}

/** 汇总 API 代理请求用量 */
export function getRequestUsageSummary({ days = 30 } = {}) {
  const since = Date.now() - days * 86400 * 1000
  return db.prepare(`
    ${usageLogsCte()}
    SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successful_requests,
      COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failed_requests,
      COALESCE(SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END), 0) as streaming_requests,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cost_credits), 0) as total_cost
    FROM usage_logs
    WHERE created_at > ?
  `).get(since)
}

/** 按模型统计用量 */
export function getUsageByModel({ userId, days = 30 } = {}) {
  const since = Date.now() - days * 86400 * 1000
  let where = 'WHERE created_at > ? AND success = 1'
  const params = [since]
  if (userId) { where += ' AND user_id = ?'; params.push(userId) }
  return db.prepare(`
    ${usageLogsCte()}
    SELECT model, COUNT(*) as requests, SUM(total_tokens) as total_tokens, SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens, SUM(cost_credits) as total_cost
    FROM usage_logs ${where} GROUP BY model ORDER BY total_cost DESC
  `).all(...params)
}

// ===== 激活码管理 =====

/** 生成激活码 */
export function createActivationCode({ code, createdBy, expiresAt, accountType = 'standard' }) {
  const id = uuidv4()
  const now = Date.now()
  db.prepare('INSERT INTO activation_codes (id, code, status, created_by, expires_at, account_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, 'pending', createdBy, expiresAt || null, accountType, now)
  return { id, code, accountType }
}

/** 列出激活码 */
export function listActivationCodes({ status } = {}) {
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND status = ?'; params.push(status) }
  return db.prepare(`SELECT * FROM activation_codes ${where} ORDER BY created_at DESC`).all(...params)
}

/** 验证激活码。有效时返回 { valid:true, accountType } */
export function validateActivationCode(code) {
  const row = db.prepare("SELECT * FROM activation_codes WHERE code = ? AND status = 'pending'").get(code)
  if (!row) return { valid: false, error: '激活码无效' }
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("UPDATE activation_codes SET status = 'expired' WHERE id = ?").run(row.id)
    return { valid: false, error: '激活码已过期' }
  }
  return { valid: true, accountType: row.account_type || 'standard' }
}

/** 使用激活码 */
export function useActivationCode(code, userId) {
  const now = Date.now()
  db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending'")
    .run(userId, now, code)
}

// ===== 定价管理 =====

/** 获取所有价格 */
export function listPricing() {
  return db.prepare('SELECT model, input_rate, output_rate, cache_read_ratio, updated_at FROM pricing ORDER BY model').all()
}

/** 获取单个模型价格 */
export function getPricing(model) {
  return db.prepare('SELECT model, input_rate, output_rate, cache_read_ratio FROM pricing WHERE model = ?').get(model)
}

/** 更新或插入价格 */
export function upsertPricing(model, inputRate, outputRate, cacheReadRatio) {
  db.prepare('INSERT INTO pricing (model, input_rate, output_rate, cache_read_ratio, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(model) DO UPDATE SET input_rate = excluded.input_rate, output_rate = excluded.output_rate, cache_read_ratio = excluded.cache_read_ratio, updated_at = excluded.updated_at')
    .run(model, inputRate, outputRate, cacheReadRatio ?? 0.1, Date.now())
}

/** 删除价格 */
export function deletePricing(model) {
  db.prepare('DELETE FROM pricing WHERE model = ?').run(model)
}

/** 获取所有价格（给代理/中间件用的快速查找表） */
export function getPricingMap() {
  const rows = listPricing()
  const map = {}
  for (const r of rows) {
    map[r.model] = { input: r.input_rate, output: r.output_rate, cacheReadRatio: r.cache_read_ratio }
  }
  return map
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
  const usageSummary = getRequestUsageSummary({ days: 30 })

  const topUsers = db.prepare(`
    ${usageLogsCte()}
    SELECT u.id, u.email, u.display_name,
           COUNT(rl.id) as requests,
           COALESCE(SUM(rl.cost_credits), 0) as consumed,
           COALESCE(SUM(rl.total_tokens), 0) as total_tokens
    FROM usage_logs rl
    LEFT JOIN users u ON u.id = rl.user_id
    WHERE rl.created_at > ? AND rl.success = 1
    GROUP BY rl.user_id
    ORDER BY consumed DESC, requests DESC
    LIMIT 10
  `).all(monthStart)

  return {
    totalUsers, activeToday, activeChannels, totalWorkspaces,
    totalBalance: creditSummary.total_balance,
    totalConsumed: creditSummary.total_consumed,
    consumedThisMonth: creditSummary.consumed_this_month,
    usageRequests: usageSummary.total_requests,
    usageSuccessfulRequests: usageSummary.successful_requests,
    usageFailedRequests: usageSummary.failed_requests,
    usageStreamingRequests: usageSummary.streaming_requests,
    usageTotalTokens: usageSummary.total_tokens,
    usagePromptTokens: usageSummary.prompt_tokens,
    usageCompletionTokens: usageSummary.completion_tokens,
    usageCacheCreationTokens: usageSummary.cache_creation_tokens,
    usageCacheReadTokens: usageSummary.cache_read_tokens,
    usageTotalCost: usageSummary.total_cost,
    topUsers
  }
}
