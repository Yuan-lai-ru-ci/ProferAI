import Database from 'better-sqlite3'
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD, DEFAULT_CREDIT_GRANT } from './config.js'
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
// Phase 1 付费体系 — 邀请 + 会员 + 积分分账
try { db.exec("ALTER TABLE users ADD COLUMN invite_code TEXT UNIQUE") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN invited_by TEXT") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN membership_tier TEXT NOT NULL DEFAULT 'free'") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN is_vip INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN multiplier REAL NOT NULL DEFAULT 1.0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN balance_purchased INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN balance_referral INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN balance_package INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN new_api_user_id INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN new_api_key_encrypted TEXT DEFAULT NULL") } catch (_) {}
// 多设备 refresh token 支持：每个设备独立持有 token，不再互相踢下线
try { db.exec(`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    device_name TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`) } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)') } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)') } catch (_) {}
// 稳定设备标识（注册设备数模型）：客户端生成 UUID 存 OS 级持久位置，登录/刷新带上
try { db.exec("ALTER TABLE refresh_tokens ADD COLUMN device_id TEXT DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE refresh_tokens ADD COLUMN platform TEXT DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE refresh_tokens ADD COLUMN app_version TEXT DEFAULT NULL") } catch (_) {}
// 同一账号同一设备只保留一行（device_id 为空的存量行不受唯一约束影响，兼容旧客户端）
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id) WHERE device_id IS NOT NULL") } catch (_) {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN restored_at INTEGER DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE workspaces ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0") } catch (_) {}
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
// 同步序列号计数器：单调递增真源，替代每次写入的 MAX(seq) 全表扫描
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_seq_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
  )
`)
// 首次创建时用当前最大 seq 播种，保证与历史信封连续（仅在行不存在时执行一次）
try {
  const seed = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_envelopes').get()?.m ?? 0
  db.prepare('INSERT OR IGNORE INTO sync_seq_counter (id, value) VALUES (1, ?)').run(seed)
} catch (_) {}

// 原子预留一段连续的同步序列号，返回该段的第一个值。
// 用单行计数器自增替代 SELECT MAX(seq) 全表扫描；better-sqlite3 事务同步执行，天然互斥。
const _incSeqStmt = db.prepare('UPDATE sync_seq_counter SET value = value + ? WHERE id = 1')
const _getSeqStmt = db.prepare('SELECT value FROM sync_seq_counter WHERE id = 1')
const _reserveSeqTx = db.transaction((count) => {
  _incSeqStmt.run(count)
  const after = _getSeqStmt.get().value
  return after - count + 1 // 本段第一个 seq
})
/** 预留 count 个连续序列号，返回第一个。count 默认 1。 */
export function reserveSyncSeq(count = 1) {
  const n = Math.max(1, count | 0)
  return _reserveSeqTx(n)
}
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

// 公告表
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (author_id) REFERENCES users(id)
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
// hash-chain 完整性列
try { db.exec("ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''") } catch (_) {}
try { db.exec("ALTER TABLE audit_logs ADD COLUMN row_hash TEXT NOT NULL DEFAULT ''") } catch (_) {}
try { db.exec("ALTER TABLE audit_logs ADD COLUMN nonce TEXT NOT NULL DEFAULT ''") } catch (_) {}
db.exec('CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON token_blacklist(expires_at)')

// hash-chain 回填已有审计日志（仅首次运行）
try {
  const needsBackfill = db.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE row_hash = ''").get().cnt
  if (needsBackfill > 0) {
    const rows = db.prepare("SELECT id, action, user_id, entity_type, entity_id, detail, created_at FROM audit_logs WHERE row_hash = '' ORDER BY id ASC").all()
    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000'
    const update = db.prepare('UPDATE audit_logs SET prev_hash = ?, row_hash = ?, nonce = ? WHERE id = ?')
    for (const row of rows) {
      const nonce = crypto.randomBytes(8).toString('hex')
      const payload = [prevHash, row.action, row.user_id || '', row.entity_type || '', row.entity_id || '', row.detail || '', String(row.created_at), nonce].join('|')
      const rowHash = crypto.createHash('sha256').update(payload).digest('hex')
      update.run(prevHash, rowHash, nonce, row.id)
      prevHash = rowHash
    }
    console.log(`[db] 审计日志 hash-chain 回填完成: ${rows.length} 条`)
  }
} catch (_) { /* 忽略回填错误 */ }

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
try { db.exec("ALTER TABLE credit_transactions ADD COLUMN source_balance TEXT DEFAULT ''") } catch (_) {}
try { db.exec("ALTER TABLE channels ADD COLUMN agent_base_url TEXT DEFAULT ''") } catch (_) {}
// 渠道 scope：global（全用户可用）/ test（仅管理员测试用）
try { db.exec("ALTER TABLE channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'") } catch (_) {}

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
try { db.exec("ALTER TABLE request_logs ADD COLUMN new_api_request_id TEXT NOT NULL DEFAULT ''") } catch (_) {}
db.exec("CREATE INDEX IF NOT EXISTS idx_rl_unbilled ON request_logs(cost_credits, success, new_api_request_id)")

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

// 兑换码表 — 管理员生成，已注册用户兑换额度/套餐/VIP
db.exec(`
  CREATE TABLE IF NOT EXISTS redemption_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    cycle TEXT DEFAULT 'monthly',
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    used_by TEXT DEFAULT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    used_at INTEGER DEFAULT NULL
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_rc_code ON redemption_codes(code)')

// ===== Phase 1 付费体系新表 =====

// 邀请码表 — 每位用户专属邀请码，注册必填
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    total_invites INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code)')
db.exec('CREATE INDEX IF NOT EXISTS idx_invite_codes_user ON invite_codes(user_id)')

// 订单表 — 交易订单，手动确认收款
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    plan TEXT,
    amount_rmb INTEGER NOT NULL,
    credits INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_method TEXT NOT NULL DEFAULT 'manual',
    confirmed_by TEXT,
    confirmed_at INTEGER,
    remark TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)')
try { db.exec("ALTER TABLE orders ADD COLUMN cycle TEXT NOT NULL DEFAULT 'monthly'") } catch (_) {}
// 订单创建者（用于双人确认校验）
try { db.exec("ALTER TABLE orders ADD COLUMN created_by TEXT DEFAULT ''") } catch (_) {}

// 套餐订阅表 — 订阅状态、drip rate、红包记录
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    welcome_bonus_claimed INTEGER NOT NULL DEFAULT 0,
    welcome_bonus_amount INTEGER NOT NULL DEFAULT 0,
    daily_drip_rate INTEGER NOT NULL DEFAULT 0,
    vip_discount_applied INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    expires_at INTEGER,
    renewed_at INTEGER,
    destroyed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)')
try { db.exec("ALTER TABLE subscriptions ADD COLUMN cycle TEXT NOT NULL DEFAULT 'monthly'") } catch (_) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN drip_available_this_week INTEGER NOT NULL DEFAULT 0") } catch (_) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN drip_last_accrual_date TEXT DEFAULT NULL") } catch (_) {}
try { db.exec("ALTER TABLE subscriptions ADD COLUMN drip_last_claimed_date TEXT DEFAULT NULL") } catch (_) {}

// 邀请返利记录表
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_records (
    id TEXT PRIMARY KEY,
    inviter_id TEXT NOT NULL,
    invitee_id TEXT NOT NULL,
    event TEXT NOT NULL,
    credits_earned INTEGER NOT NULL DEFAULT 0,
    order_id TEXT,
    purchase_index INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (inviter_id) REFERENCES users(id),
    FOREIGN KEY (invitee_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_invite_records_inviter ON invite_records(inviter_id)')

// ===== 开放 API：用户自建 API Key =====
// pk_ 前缀的长效 key，供用户通过 HTTP 调 /v1/proxy 访问。
// 铁律：只存 sha256 hash，不存明文；pk_ 只用于反查用户，绝不等于平台 RELAY_API_KEY。
// quota_limit 为该 key 的额度上限（quota 单位，null=不限）；quota_used 累计已用。
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    key_prefix TEXT NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    quota_limit INTEGER,
    quota_used INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)')

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
           u.is_vip,
           u.created_at, u.failed_login_attempts, u.locked_until,
           u.membership_tier,
           u.new_api_user_id,
           CASE WHEN u.new_api_key_encrypted IS NOT NULL THEN 1 ELSE 0 END as has_new_api_key,
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
  const allowed = ['display_name', 'is_suspended', 'is_admin', 'membership_tier']
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
  // 不能撤销最后一位管理员
  const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1').get().cnt
  if (adminCount <= 1) throw new Error('CANNOT_DEMOTE_LAST_ADMIN')
  return db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(userId)
}

/** 彻底删除用户及其关联数据（额度/交易/日志/工作区成员关系） */
export function deleteUser(userId) {
  // 不能删除最后一位管理员
  const target = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId)
  if (target?.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1').get().cnt
    if (adminCount <= 1) throw new Error('CANNOT_DELETE_LAST_ADMIN')
  }
  const tx = db.transaction(() => {
    // 1. 清理用户拥有的工作区及其关联数据（owner_id 有 FK → users）
    const ownedWorkspaces = db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(userId)
    for (const ws of ownedWorkspaces) {
      db.prepare('DELETE FROM file_manifests WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM sync_envelopes WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM invitations WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM announcements WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(ws.id)
    }
    db.prepare('DELETE FROM workspaces WHERE owner_id = ?').run(userId)

    // 2. 清理用户直接关联数据（均有 FK → users，顺序无关但先删子表）
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM invite_codes WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM invite_records WHERE inviter_id = ? OR invitee_id = ?').run(userId, userId)
    db.prepare('DELETE FROM announcements WHERE author_id = ?').run(userId)
    db.prepare('DELETE FROM credit_transactions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM credits WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM request_logs WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(userId)

    // 3. 最后删除用户本身
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

/** 按 relay 令牌反查用户（proxy 鉴权用）。返回 id/email/membership_tier 等。 */
export function getUserByRelayToken(token) {
  if (!token) return undefined
  return db.prepare('SELECT id, email, is_admin, is_suspended, membership_tier FROM users WHERE relay_token = ?').get(token)
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

export function createChannel({ id, name, provider, apiKeyEncrypted, baseUrl, agentBaseUrl, modelsJson, createdBy, scope = 'test' }) {
  const now = Date.now()
  return db.prepare(`
    INSERT INTO channels (id, name, provider, api_key_encrypted, base_url, agent_base_url, models_json, is_active, created_by, created_at, updated_at, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(id, name, provider, apiKeyEncrypted, baseUrl || '', agentBaseUrl || '', modelsJson || '[]', createdBy || '', now, now, scope)
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

/** 确保用户有额度行。统一给默认初始额度（写入 balance_package）。 */
export function ensureCreditRow(userId) {
  const existing = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(userId)
  if (!existing) {
    const grant = DEFAULT_CREDIT_GRANT
    const now = Date.now()
    db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)').run(userId, grant, now)
    // 同步写入 users.balance_package（真账本）— 注册赠送属于套餐积分
    db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?').run(grant, userId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, 'grant', ?, ?)`)
      .run(uuidv4(), userId, grant, `注册赠送额度 (${grant} quota)`, now)
  }
}

export function grantCredits(adminUserId, targetUserId, amount, description) {
  const now = Date.now()
  const tx = db.transaction(() => {
    ensureCreditRow(targetUserId)
    // 写入 users.balance_purchased（真账本），避免只更新 credits 镜像账本导致后续扣费覆写
    db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?').run(amount, targetUserId)
    // 同步 credits.balance = 三桶总和
    syncCreditBalance(targetUserId)
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

// ===== Phase 1 积分三桶扣款 =====

/** 积分透支上限（quota 单位，-50 积分 = -2,500,000 quota） */
const OVERDRAFT_LIMIT = 2_500_000

/** 三桶扣款优先级：balance_package → balance_referral → balance_purchased */
const BUCKET_ORDER = ['balance_package', 'balance_referral', 'balance_purchased']

/**
 * 按三桶优先级扣款。
 * - balance_package（套餐积分：红包+drip）→ balance_referral（返利）→ balance_purchased（充值）
 * - 允许透支：balance_purchased 最低可至 -OVERDRAFT_LIMIT
 * - 扣款后同步 credits.balance = sum(三桶)，保持 credit-gate 兼容
 * - credit_transactions 每桶独立写一行，source_balance 标记来源
 *
 * @throws {Error} INSUFFICIENT_CREDITS:<总余额> 当三桶合计（含透支上限）仍不足时
 */
export function deductCredits(userId, amount, { description, referenceType, referenceId, force } = {}) {
  const now = Date.now()
  const deduct = db.transaction(() => {
    const user = db.prepare(
      'SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?'
    ).get(userId)
    if (!user) throw new Error(`INSUFFICIENT_CREDITS:0`)

    const buckets = {
      balance_package: user.balance_package || 0,
      balance_referral: user.balance_referral || 0,
      balance_purchased: user.balance_purchased || 0,
    }
    // force: 事后对账必须记账，允许无限透支；正常路径不允许超过 OVERDRAFT_LIMIT
    const effectiveOverdraft = force ? Infinity : OVERDRAFT_LIMIT
    const available = buckets.balance_package + buckets.balance_referral + buckets.balance_purchased + effectiveOverdraft
    if (available < amount) {
      throw new Error(`INSUFFICIENT_CREDITS:${buckets.balance_package + buckets.balance_referral + buckets.balance_purchased}`)
    }

    let remaining = amount
    const deductions = []
    for (const bucket of BUCKET_ORDER) {
      if (remaining <= 0) break
      const take = Math.min(buckets[bucket] + (bucket === 'balance_purchased' ? effectiveOverdraft : 0), remaining)
      if (take > 0) {
        deductions.push({ bucket, amount: take })
        remaining -= take
      }
    }

    // 扣减各桶 + 写流水
    for (const d of deductions) {
      db.prepare(`UPDATE users SET ${d.bucket} = ${d.bucket} - ? WHERE id = ?`).run(d.amount, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'consumption', ?, ?, ?, ?, ?)`)
        .run(uuidv4(), userId, -d.amount, description || '', d.bucket, referenceType || '', referenceId || '', now)
    }

    // 同步 credits.balance = 三桶总和（保持 credit-gate 兼容）
    const newTotal = (buckets.balance_package - (deductions.find(d => d.bucket === 'balance_package')?.amount || 0))
      + (buckets.balance_referral - (deductions.find(d => d.bucket === 'balance_referral')?.amount || 0))
      + (buckets.balance_purchased - (deductions.find(d => d.bucket === 'balance_purchased')?.amount || 0))
    ensureCreditRow(userId)
    db.prepare('UPDATE credits SET balance = ?, lifetime_consumed = lifetime_consumed + ?, updated_at = ? WHERE user_id = ?')
      .run(newTotal, amount, now, userId)

    return deductions[0]?.amount ? deductions.map(d => `${d.bucket}:${d.amount}`).join(',') : ''
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
      COALESCE(SUM(c.balance), 0) as total_balance
    FROM credits c
  `).get()
  // 累计消耗从 credit_transactions 计算，而非 credits.lifetime_consumed。
  // batch-reset 会清零 lifetime_consumed，用 transactions 可保证仪表盘数据不被重置影响。
  const totalConsumed = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN type = 'consumption' THEN -amount
      WHEN type = 'refund' THEN -amount
      ELSE 0
    END), 0) as total_consumed
    FROM credit_transactions
    WHERE type IN ('consumption', 'refund')
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
  return { ...balance, total_consumed: totalConsumed.total_consumed, consumed_this_month: month.consumed_this_month }
}

// ===== 请求日志 =====

/** 记录一次 API 代理请求 */
export function logRequest(params) {
  return db.prepare(buildRequestLogInsertSql()).run(...buildRequestLogValues(params))
}

/**
 * 扣费循环：扫描未扣费的成功请求，按 New API request_id 补扣。
 * @returns {Promise<{ billed: number, skipped: number }>}
 */
export async function sweepUnbilledRequests({ batchSize = 100, maxAgeMs = 86400_000 * 7, minAgeMs = 120_000 } = {}) {
  const cutoff = Date.now() - maxAgeMs
  const minCreatedAt = Date.now() - minAgeMs
  const rows = db.prepare(`
    SELECT id, user_id, new_api_request_id, created_at
    FROM request_logs
    WHERE cost_credits = 0
      AND success = 1
      AND new_api_request_id != ''
      AND created_at > ? AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(cutoff, minCreatedAt, batchSize)

  if (!rows.length) return { billed: 0, skipped: 0 }

  const { reconcileRequestCost } = await import('./newapi-client.js')

  let billed = 0
  let skipped = 0

  for (const row of rows) {
    try {
      const rec = await reconcileRequestCost(row.new_api_request_id)
      if (!rec.found || rec.billedCredits <= 0) {
        skipped++
        // 超过 4 天仍未找到 → 标记为不可对账（cost_credits=-1），避免无限重试
        if (!rec.found && Date.now() - row.created_at > 86400_000 * 4) {
          db.prepare('UPDATE request_logs SET cost_credits = -1 WHERE id = ?').run(row.id)
        }
        continue
      }
      try { claimDrip(row.user_id) } catch (_) { /* drip 失败不阻塞 */ }
      deductCredits(row.user_id, rec.billedCredits, {
        description: `后台补扣（New API quota ${rec.quota}）`,
        referenceType: 'api_call_sweep',
        referenceId: row.id,
        force: true,
      })
      db.prepare('UPDATE request_logs SET cost_credits = ? WHERE id = ?').run(rec.billedCredits, row.id)
      billed++
    } catch (e) {
      console.warn(`[sweep] 补扣失败 request_log=${row.id}: ${e.message}`)
      skipped++
    }
  }

  if (billed > 0 || skipped > 0) {
    console.log(`[sweep] 本轮: ${billed} 笔补扣, ${skipped} 笔跳过 (共扫描 ${rows.length} 笔)`)
  }
  return { billed, skipped }
}

/** 更新单条请求日志的扣费额度（用于内联对账成功后回写） */
export function updateRequestLogCost(requestId, costCredits) {
  db.prepare('UPDATE request_logs SET cost_credits = ? WHERE id = ?').run(costCredits, requestId)
}

/** 根据实际用量调整已扣额度（正值=多退，负值=少补） */
export function adjustCreditDeduction(userId, oldAmount, newAmount, referenceId) {
  const diff = oldAmount - newAmount
  if (diff === 0) return
  const now = Date.now()
  const tx = db.transaction(() => {
    if (diff > 0) {
      // 多扣了，统一退到 balance_purchased（最后优先级桶）
      db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
        .run(diff, userId)
      db.prepare('UPDATE credits SET balance = balance + ?, lifetime_consumed = MAX(0, lifetime_consumed - ?), updated_at = ? WHERE user_id = ?')
        .run(diff, diff, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'refund', ?, 'balance_purchased', 'api_adjust', ?, ?)`)
        .run(uuidv4(), userId, diff, `实际用量调整：退还 ${diff} credits`, referenceId, now)
    } else {
      // 少扣了，优先从 balance_purchased 补扣（不检查余额，用量已发生）
      const extra = -diff
      db.prepare('UPDATE users SET balance_purchased = balance_purchased - ? WHERE id = ?')
        .run(extra, userId)
      db.prepare('UPDATE credits SET balance = MAX(0, balance - ?), lifetime_consumed = lifetime_consumed + ?, updated_at = ? WHERE user_id = ?')
        .run(extra, extra, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'consumption', ?, 'balance_purchased', 'api_adjust', ?, ?)`)
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
export function createActivationCode({ code, createdBy, expiresAt, membershipTier = 'free' }) {
  const id = uuidv4()
  const now = Date.now()
  db.prepare('INSERT INTO activation_codes (id, code, status, created_by, expires_at, account_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, 'pending', createdBy, expiresAt || null, membershipTier, now)
  return { id, code, membershipTier }
}

/** 列出激活码 */
export function listActivationCodes({ status } = {}) {
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND status = ?'; params.push(status) }
  return db.prepare(`SELECT * FROM activation_codes ${where} ORDER BY created_at DESC`).all(...params)
}

/** 验证激活码。有效时返回 { valid:true, membershipTier } */
export function validateActivationCode(code) {
  const row = db.prepare("SELECT * FROM activation_codes WHERE code = ? AND status = 'pending'").get(code)
  if (!row) return { valid: false, error: '激活码无效' }
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("UPDATE activation_codes SET status = 'expired' WHERE id = ?").run(row.id)
    return { valid: false, error: '激活码已过期' }
  }
  return { valid: true, membershipTier: row.account_type || 'free' }
}

/** 使用激活码 */
export function useActivationCode(code, userId) {
  const now = Date.now()
  db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending'")
    .run(userId, now, code)
}

// ===== 兑换码管理（额度/套餐/VIP 兑换）=====

/** 生成兑换码 */
export function createRedemptionCode({ code, type, value, cycle = 'monthly', createdBy, expiresAt }) {
  const id = uuidv4()
  const now = Date.now()
  db.prepare('INSERT INTO redemption_codes (id, code, type, value, cycle, status, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, type, value, cycle, 'active', createdBy, expiresAt || null, now)
  return { id, code, type, value, cycle }
}

/** 列出兑换码 */
export function listRedemptionCodes({ status, type } = {}) {
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND status = ?'; params.push(status) }
  if (type) { where += ' AND type = ?'; params.push(type) }
  return db.prepare(`SELECT rc.*, u.email as used_by_email FROM redemption_codes rc LEFT JOIN users u ON u.id = rc.used_by ${where} ORDER BY rc.created_at DESC`).all(...params)
}

/** 验证兑换码。有效返回 { valid:true, type, value, cycle } */
export function validateRedemptionCode(code) {
  const row = db.prepare("SELECT * FROM redemption_codes WHERE code = ? AND status = 'active'").get(code)
  if (!row) return { valid: false, error: '兑换码无效' }
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("UPDATE redemption_codes SET status = 'expired' WHERE id = ?").run(row.id)
    return { valid: false, error: '兑换码已过期' }
  }
  return { valid: true, id: row.id, type: row.type, value: row.value, cycle: row.cycle || 'monthly' }
}

/** 标记兑换码已使用 */
export function markRedemptionCodeUsed(codeId, userId) {
  const now = Date.now()
  db.prepare("UPDATE redemption_codes SET status = 'used', used_by = ?, used_at = ? WHERE id = ?")
    .run(userId, now, codeId)
}

/**
 * 执行兑换：根据 type 发放对应权益。
 * - credits: value 为积分数量，写入 balance_purchased
 * - plan: value 为套餐名 (standard/plus/pro)，cycle 为周期，创建/续费订阅
 * - vip: 设置 is_vip = 1，终身 VIP
 * 返回 { success, description } 供 API 响应和审计日志。
 */
export function redeemCode(userId, { id: codeId, type, value, cycle }) {
  const now = Date.now()
  const PLAN_DEFS_REDEEM = {
    standard: { monthlyRmb: 2900, yearlyRmb: 29600, welcomeBonus: 60, dailyDrip: 8 },
    plus:     { monthlyRmb: 4900, yearlyRmb: 50000, welcomeBonus: 200, dailyDrip: 20 },
    pro:      { monthlyRmb: 9900, yearlyRmb: 101000, welcomeBonus: 450, dailyDrip: 40 },
  }
  const VIP_EXTRA_DRIP_REDEEM = 20

  const tx = db.transaction(() => {
    // 幂等检查：该兑换码在当前事务中是否已被使用
    const current = db.prepare("SELECT status FROM redemption_codes WHERE id = ?").get(codeId)
    if (current?.status !== 'active') throw new Error('CODE_ALREADY_USED')

    let description = ''

    switch (type) {
      case 'credits': {
        const points = parseInt(value, 10) || 0
        if (points <= 0) throw new Error('INVALID_CREDITS_VALUE')
        const quota = pointsToQuota(points)
        db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
          .run(quota, userId)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, quota, `兑换码兑换 ${points} 积分`, codeId, now)
        // 同步 credits.balance
        syncCreditBalance(userId)
        description = `兑换 ${points} 积分`
        break
      }

      case 'plan': {
        const plan = PLAN_DEFS_REDEEM[value]
        if (!plan) throw new Error('INVALID_PLAN')
        const isYearly = cycle === 'yearly'
        const bonusMultiplier = isYearly ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)
        const dripRate = plan.dailyDrip
        const expiresMs = isYearly ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        // 检查是否已有 VIP
        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
        const isVip = user?.is_vip || false
        const actualDripRate = dripRate + (isVip ? VIP_EXTRA_DRIP_REDEEM : 0)

        // upsert 订阅
        const existingSub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(userId)
        if (existingSub) {
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active', welcome_bonus_claimed = 1,
            welcome_bonus_amount = ?, daily_drip_rate = ?, vip_discount_applied = ?,
            cycle = ?, started_at = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL WHERE user_id = ?`)
            .run(value, welcomeBonusQuota, actualDripRate, isVip ? 1 : 0, cycle, now, now + expiresMs, now, userId)
        } else {
          db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed, welcome_bonus_amount,
            daily_drip_rate, vip_discount_applied, cycle, started_at, expires_at, created_at)
            VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), userId, value, welcomeBonusQuota, actualDripRate, isVip ? 1 : 0, cycle, now, now + expiresMs, now)
        }

        // 更新用户等级
        db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(value, userId)

        // 红包写入 balance_package
        db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
          .run(welcomeBonusQuota, userId)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'package', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, welcomeBonusQuota,
            `兑换码兑换 ${value}${isYearly ? '年付' : '月付'}套餐，红包 ${welcomeBonusPoints} 积分`, codeId, now)

        syncCreditBalance(userId)
        description = `兑换 ${value}${isYearly ? '年付' : '月付'}套餐`
        break
      }

      case 'vip': {
        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
        if (user?.is_vip) throw new Error('ALREADY_VIP')

        db.prepare('UPDATE users SET is_vip = 1, multiplier = 0.8 WHERE id = ?').run(userId)
        // 已有活跃订阅则叠加 drip
        db.prepare(`UPDATE subscriptions SET daily_drip_rate = daily_drip_rate + ? WHERE user_id = ? AND status = 'active'`)
          .run(VIP_EXTRA_DRIP_REDEEM, userId)
        // 写流水（金额为 0，记录事件）
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, 0, `兑换码兑换 VIP 终身会员`, codeId, now)
        description = '兑换 VIP 终身会员'
        break
      }

      default:
        throw new Error('INVALID_REDEMPTION_TYPE')
    }

    // 标记兑换码已使用
    markRedemptionCodeUsed(codeId, userId)

    return { success: true, description }
  })

  return tx()
}

/** 同步 credits.balance = 三桶总和 */
function syncCreditBalance(userId) {
  const totals = db.prepare('SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?').get(userId)
  if (totals) {
    ensureCreditRow(userId)
    const total = (totals.balance_package || 0) + (totals.balance_referral || 0) + (totals.balance_purchased || 0)
    db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?').run(total, Date.now(), userId)
  }
}

// ===== 邀请码管理 =====

/** 生成邀请码：U + 6 位字母数字（去掉易混淆的 0/O/1/I） */
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'U'
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }
  return code
}

/** 为用户创建专属邀请码（一人一码，幂等） */
export function createInviteCode(userId) {
  const existing = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(userId)
  if (existing) return existing.code
  // 极低概率碰撞，循环到成功
  let code, retries = 0
  do {
    code = generateInviteCode()
    retries++
  } while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code) && retries < 10)
  db.prepare('INSERT INTO invite_codes (id, user_id, code, created_at) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), userId, code, Date.now())
  return code
}

/** 按邀请码查找邀请人 */
export function getInviterByCode(code) {
  return db.prepare(`
    SELECT ic.user_id, ic.code, u.email, u.display_name
    FROM invite_codes ic
    JOIN users u ON u.id = ic.user_id
    WHERE ic.code = ? AND ic.status = 'active'
  `).get(code)
}

/** 获取用户的邀请码 */
export function getUserInviteCode(userId) {
  return db.prepare('SELECT * FROM invite_codes WHERE user_id = ?').get(userId)
}

/** 获取用户邀请的人列表 */
export function getUserInvitees(userId) {
  return db.prepare(`
    SELECT u.id, u.email, u.display_name, u.created_at,
           ir.event, ir.credits_earned, ir.created_at as event_at
    FROM invite_records ir
    JOIN users u ON u.id = ir.invitee_id
    WHERE ir.inviter_id = ?
    ORDER BY ir.created_at DESC
  `).all(userId)
}

/** 记录邀请事件 */
export function recordInviteEvent({ inviterId, inviteeId, event, creditsEarned = 0, orderId = null, purchaseIndex = 0 }) {
  db.prepare(`INSERT INTO invite_records (id, inviter_id, invitee_id, event, credits_earned, order_id, purchase_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), inviterId, inviteeId, event, creditsEarned, orderId || null, purchaseIndex, Date.now())
  // 更新邀请人的总邀请数
  if (event === 'register') {
    db.prepare('UPDATE invite_codes SET total_invites = total_invites + 1 WHERE user_id = ?')
      .run(inviterId)
  }
}

// ===== 订单管理 =====

/** 创建订单。amountRmb 人民币分，credits 内部换算为 quota 单位存储 */
export function createOrder({ userId, type, plan = null, cycle = 'monthly', amountRmb, credits, remark = '', createdBy = '' }) {
  const id = uuidv4()
  // credits 参数来自 admin orders API：积分 = amountRmb / 10，换算为 quota（50000 quota/积分）
  const quotaCredits = (credits || Math.round(amountRmb / 10)) * 50000
  db.prepare(`INSERT INTO orders (id, user_id, type, plan, amount_rmb, credits, status, remark, cycle, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, userId, type, plan, amountRmb, quotaCredits, remark, cycle, createdBy, Date.now())
  return { id, quotaCredits }
}

const NEWAPI_QPU = 500000 // quota per $1 unit

// ===== 套餐定价常量（积分单位，1 积分 = 50000 quota）=====
const PLAN_DEFS = {
  standard: { monthlyRmb: 2900, yearlyRmb: 29600, welcomeBonus: 60, dailyDrip: 8 },
  plus:     { monthlyRmb: 4900, yearlyRmb: 50000, welcomeBonus: 200, dailyDrip: 20 },
  pro:      { monthlyRmb: 9900, yearlyRmb: 101000, welcomeBonus: 450, dailyDrip: 40 },
}
const VIP_DISCOUNT = 0.9   // VIP 套餐 9 折
const VIP_EXTRA_DRIP = 20  // VIP 额外每日 drip（积分单位）

/** 积分 → quota */
function pointsToQuota(points) {
  return Math.round(points * 50_000)
}

/** 确认收款：pending → paid，加积分/设 VIP/激活套餐/记流水 */
export function confirmOrder(orderId, adminUserId) {
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'pending')
    if (!order) throw new Error('ORDER_NOT_FOUND')

    const now = Date.now()
    db.prepare('UPDATE orders SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?')
      .run('paid', adminUserId, now, orderId)

    switch (order.type) {
      case 'topup':
        db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
          .run(order.credits, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, order.credits,
            `手动充值 ¥${(order.amount_rmb / 100).toFixed(2)} → ${order.credits} 积分`,
            orderId, now)
        break

      case 'vip':
        db.prepare('UPDATE users SET is_vip = 1, multiplier = 0.8 WHERE id = ?')
          .run(order.user_id)
        // VIP 购买给余额 + 已有订阅的 drip 自动 +20
        db.prepare(`UPDATE subscriptions SET daily_drip_rate = daily_drip_rate + ? WHERE user_id = ? AND status = 'active'`)
          .run(VIP_EXTRA_DRIP, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, 0,
            `VIP 终身会员 ¥${(order.amount_rmb / 100).toFixed(2)}`,
            orderId, now)
        break

      case 'subscription': {
        const plan = PLAN_DEFS[order.plan] || PLAN_DEFS.standard
        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(order.user_id)
        const isVip = user?.is_vip || order.plan === 'vip'  // fallback
        const cycle = order.cycle || 'monthly'

        // 价格（VIP 9 折）
        const baseRmb = cycle === 'yearly' ? plan.yearlyRmb : plan.monthlyRmb
        const actualRmb = isVip ? Math.round(baseRmb * VIP_DISCOUNT) : baseRmb

        // 红包
        const bonusMultiplier = cycle === 'yearly' ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)

        // 每日 drip
        const dripRate = plan.dailyDrip + (isVip ? VIP_EXTRA_DRIP : 0)

        // 到期时间
        const expiresMs = cycle === 'yearly' ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        // 写 subscription 行（upsert：已有订阅则更新）
        const existingSub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(order.user_id)
        if (existingSub) {
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active', welcome_bonus_claimed = 1,
            welcome_bonus_amount = ?, daily_drip_rate = ?, vip_discount_applied = ?,
            started_at = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL, created_at = ? WHERE user_id = ?`)
            .run(order.plan, welcomeBonusQuota, dripRate, isVip ? 1 : 0, now, now + expiresMs, now, now, order.user_id)
        } else {
          db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed, welcome_bonus_amount,
            daily_drip_rate, vip_discount_applied, started_at, expires_at, created_at)
            VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), order.user_id, order.plan, welcomeBonusQuota, dripRate, isVip ? 1 : 0, now, now + expiresMs, now)
        }

        // 更新用户等级
        db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?')
          .run(order.plan, order.user_id)

        // 红包写入 balance_package
        db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
          .run(welcomeBonusQuota, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'package', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, welcomeBonusQuota,
            `${order.plan}${cycle === 'yearly' ? '年付' : '月付'} 首购红包 ${welcomeBonusPoints} 积分` +
            (isVip ? ` (VIP 9折)` : ''),
            orderId, now)

        // 同步 credits.balance
        const totals = db.prepare('SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?').get(order.user_id)
        if (totals) {
          ensureCreditRow(order.user_id)
          const total = (totals.balance_package || 0) + (totals.balance_referral || 0) + (totals.balance_purchased || 0)
          db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?').run(total, now, order.user_id)
        }
        break
      }
    }

    // 邀请返利：确认付款后自动给邀请人发奖励
    rewardReferrerOnPurchase(order)
  })
  tx()
}

/** 标记订单过期 */
export function expireOrder(orderId) {
  db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(orderId)
}

// ===== Phase 3: 邀请返利 =====

/** 返利积分单位换算 */
function rewardPointsToQuota(points) {
  return points * 50_000
}

/**
 * 首次（非续费）购买套餐/充值/VIP 时触发邀请返利。
 * - 被邀请人前 3 次付费 → 邀请人 +10% 订单积分
 * - 被邀请人购买 VIP → 邀请人 +300 积分
 * - 写入 invite_records + balance_referral
 *
 * 在 confirmOrder 事务内调用，保证原子性。
 */
function rewardReferrerOnPurchase(order) {
  if (order.type === 'subscription') {
    // 只对首次购买返利（续费的 renewed_at 字段非空跳过）
    const sub = db.prepare('SELECT renewed_at FROM subscriptions WHERE user_id = ?').get(order.user_id)
    if (sub?.renewed_at) return // 续费不返利
  }

  const user = db.prepare('SELECT invited_by FROM users WHERE id = ?').get(order.user_id)
  if (!user?.invited_by) return

  const inviterId = user.invited_by
  const now = Date.now()

  // 统计该被邀请人已有的付费次数
  const purchaseIndex = db.prepare(
    `SELECT COUNT(*) as cnt FROM invite_records WHERE inviter_id = ? AND invitee_id = ? AND event IN ('purchase', 'vip_purchase')`
  ).get(inviterId, order.user_id)?.cnt || 0

  let rewardPoints = 0
  let event = 'purchase'

  if (order.type === 'vip') {
    rewardPoints = 300
    event = 'vip_purchase'
  } else if (purchaseIndex < 3) {
    // 前 3 次付费：返订单金额 10%（积分单位）
    // order.credits 是 quota 单位，折算为积分：quota / 50000
    const orderPoints = Math.round(order.credits / 50_000)
    rewardPoints = Math.round(orderPoints * 0.1)
  }

  if (rewardPoints <= 0) return

  const rewardQuota = rewardPointsToQuota(rewardPoints)

  // 写入邀请人 balance_referral
  db.prepare('UPDATE users SET balance_referral = balance_referral + ? WHERE id = ?')
    .run(rewardQuota, inviterId)

  // 写返利流水
  db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
    VALUES (?, ?, ?, 'topup', ?, 'referral', 'invite_reward', ?, ?)`)
    .run(uuidv4(), inviterId, rewardQuota,
      `邀请返利：${event === 'vip_purchase' ? 'VIP购买' : `第${purchaseIndex + 1}次付费`} +${rewardPoints} 积分`,
      order.id, now)

  // 写 invite_records
  db.prepare(`INSERT INTO invite_records (id, inviter_id, invitee_id, event, credits_earned, order_id, purchase_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), inviterId, order.user_id, event, rewardQuota, order.id, purchaseIndex + 1, now)

  // 更新邀请码统计
  if (event !== 'vip_purchase') {
    db.prepare('UPDATE invite_codes SET total_invites = total_invites + 1 WHERE user_id = ?')
      .run(inviterId)
  }
}

// ===== Phase 2: 套餐生命周期 =====

/** 获取用户活跃订阅 */
export function getActiveSubscription(userId) {
  return db.prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(userId)
}

/** 获取用户订阅状态（含 drip 信息） */
export function getSubscriptionStatus(userId) {
  const sub = db.prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active', 'frozen') ORDER BY created_at DESC LIMIT 1"
  ).get(userId)
  if (!sub) return null
  const user = db.prepare('SELECT membership_tier, is_vip, multiplier FROM users WHERE id = ?').get(userId)
  return {
    plan: sub.plan,
    cycle: sub.cycle || 'monthly',
    status: sub.status,
    startedAt: sub.started_at,
    expiresAt: sub.expires_at,
    welcomeBonusAmount: sub.welcome_bonus_amount,
    dailyDripRate: sub.daily_drip_rate,
    vipDiscountApplied: !!sub.vip_discount_applied,
    dripAvailableThisWeek: sub.drip_available_this_week || 0,
    dripLastAccrualDate: sub.drip_last_accrual_date || null,
    dripLastClaimedDate: sub.drip_last_claimed_date || null,
    membershipTier: user?.membership_tier || 'free',
    isVip: !!user?.is_vip,
    multiplier: user?.multiplier || 1.0,
  }
}

/** 销毁套餐（不可退订，套餐积分保留到自然消耗） */
export function destroySubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'destroyed', destroyed_at = ? WHERE user_id = ? AND status = 'active'")
    .run(now, userId)
}

/** 冻结套餐（到期未续，套餐积分冻结） */
export function freezeSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'frozen' WHERE user_id = ? AND status = 'active' AND expires_at <= ?")
    .run(userId, now)
}

/** 续费解冻 */
export function unfreezeSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'active', renewed_at = ? WHERE user_id = ? AND status = 'frozen'")
    .run(now, userId)
}

/** 升级套餐：补差价，红包不补，drip 立即提级 */
export function upgradeSubscription(userId, newPlan) {
  const plan = PLAN_DEFS[newPlan]
  if (!plan) throw new Error('INVALID_PLAN')
  const now = Date.now()
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(userId)
  if (!sub) throw new Error('NO_ACTIVE_SUBSCRIPTION')
  if (sub.plan === newPlan) return // 同等级不操作

  const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
  const dripRate = plan.dailyDrip + (user?.is_vip ? VIP_EXTRA_DRIP : 0)

  db.prepare(`UPDATE subscriptions SET plan = ?, daily_drip_rate = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`)
    .run(newPlan, dripRate, now, userId)
  db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(newPlan, userId)
}

/** 标记到期（由定时任务调用） */
export function expireSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active' AND expires_at <= ?")
    .run(userId, now)
}

// ===== Phase 4: Drip 领取制 =====

/** 每日 drip 累加：将 daily_drip_rate 加入 drip_available_this_week */
export function accrueDailyDrip() {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const now = Date.now()
  const tx = db.transaction(() => {
    const subs = db.prepare(
      "SELECT id, user_id, daily_drip_rate, drip_available_this_week, drip_last_accrual_date FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)"
    ).all(now)

    let accrued = 0
    for (const sub of subs) {
      if (sub.drip_last_accrual_date === today) continue // 今日已累加
      if (!sub.daily_drip_rate || sub.daily_drip_rate <= 0) continue

      const dripQuota = pointsToQuota(sub.daily_drip_rate)
      db.prepare('UPDATE subscriptions SET drip_available_this_week = drip_available_this_week + ?, drip_last_accrual_date = ? WHERE id = ?')
        .run(dripQuota, today, sub.id)
      accrued++
    }
    return accrued
  })
  return tx()
}

/** 领取本周全部 drip：drip_available_this_week → balance_package */
export function claimDrip(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare(
      "SELECT id, drip_available_this_week, drip_last_claimed_date FROM subscriptions WHERE user_id = ? AND status = 'active'"
    ).get(userId)
    if (!sub || !sub.drip_available_this_week || sub.drip_available_this_week <= 0) return 0

    const amount = sub.drip_available_this_week
    db.prepare('UPDATE subscriptions SET drip_available_this_week = 0, drip_last_claimed_date = ? WHERE id = ?')
      .run(today, sub.id)
    db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
      .run(amount, userId)
    // 同步更新 credits 总余额（真源），避免分桶之和 ≠ 总额
    db.prepare('UPDATE credits SET balance = balance + ?, updated_at = ? WHERE user_id = ?')
      .run(amount, now, userId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'drip_claim', ?, 'package', 'drip_claim', ?, ?)`)
      .run(uuidv4(), userId, amount, `领取本周 drip ${Math.round(amount / 50000)} 积分`, sub.id, now)
    return amount
  })
  return tx()
}

/** 跨周清零未领 drip（周日调用） */
export function clearWeeklyDrip() {
  const now = Date.now()
  const tx = db.transaction(() => {
    const subs = db.prepare(
      "SELECT id, user_id, drip_available_this_week FROM subscriptions WHERE status = 'active' AND drip_available_this_week > 0"
    ).all()

    let cleared = 0
    for (const sub of subs) {
      const forfeited = sub.drip_available_this_week
      db.prepare('UPDATE subscriptions SET drip_available_this_week = 0 WHERE id = ?').run(sub.id)
      if (forfeited > 0) {
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'drip_expiry', ?, 'package', 'drip_weekly_clear', ?, ?)`)
          .run(uuidv4(), sub.user_id, 0, `周清零：过期未领 drip ${Math.round(forfeited / 50000)} 积分`, sub.id, now)
      }
      cleared++
    }
    return cleared
  })
  return tx()
}

/** 订单列表（分页、按状态筛选） */
export function listOrders({ status, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND o.status = ?'; params.push(status) }
  const total = db.prepare(`SELECT COUNT(*) as total FROM orders o ${where}`).get(...params).total
  const rows = db.prepare(`
    SELECT o.*, u.email as user_email, u.display_name as user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  return { orders: rows, total, page, limit }
}

/** 获取单个订单 */
export function getOrder(orderId) {
  return db.prepare(`
    SELECT o.*, u.email as user_email, u.display_name as user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `).get(orderId)
}

// ===== 定价管理 =====

/** 获取所有价格 */
// ===== 开放 API：用户 API Key 管理 =====

/** 生成一个新的明文 API Key（pk_ + 32 字节 hex）。仅在创建时返回一次，之后只存 hash。 */
function generateApiKey() {
  return `pk_${crypto.randomBytes(32).toString('hex')}`
}

/** key 的 sha256 hash（与 relay 令牌一致，用于反查，不存明文） */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

/**
 * 创建一把 API Key。返回 { id, plaintext, prefix }——plaintext 只此一次可见。
 * @param quotaLimit 该 key 额度上限（quota 单位，null/0 = 不限）
 */
export function createApiKey({ userId, name = '', quotaLimit = null }) {
  const id = uuidv4()
  const plaintext = generateApiKey()
  const keyHash = hashApiKey(plaintext)
  // 展示用脱敏前缀：pk_ + 前6位…后4位
  const prefix = `${plaintext.slice(0, 9)}...${plaintext.slice(-4)}`
  const limit = quotaLimit && quotaLimit > 0 ? quotaLimit : null
  db.prepare(`INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, status, quota_limit, quota_used, request_count, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, 0, 0, ?)`)
    .run(id, userId, name, prefix, keyHash, limit, Date.now())
  return { id, plaintext, prefix }
}

/** 列出某用户的所有 API Key（不含明文/hash）。 */
export function listApiKeys(userId) {
  return db.prepare(`SELECT id, name, key_prefix, status, quota_limit, quota_used, request_count, last_used_at, created_at
    FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`).all(userId)
}

/** 按 hash 反查 key 记录（proxy 鉴权用）。返回含 user_id/status/quota 等。 */
export function getApiKeyByHash(keyHash) {
  if (!keyHash) return undefined
  return db.prepare(`SELECT ak.id, ak.user_id, ak.status, ak.quota_limit, ak.quota_used,
           u.is_suspended, u.membership_tier
    FROM api_keys ak LEFT JOIN users u ON u.id = ak.user_id
    WHERE ak.key_hash = ?`).get(keyHash)
}

/** 校验某 key 是否属于指定用户（改名/启停/删除前的归属校验）。 */
function getApiKeyOwned(id, userId) {
  return db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId)
}

/** 更新 key 的名称 / 状态 / 限额（仅本人）。返回是否命中。 */
export function updateApiKey(id, userId, { name, status, quotaLimit } = {}) {
  if (!getApiKeyOwned(id, userId)) return false
  const sets = []
  const vals = []
  if (name !== undefined) { sets.push('name = ?'); vals.push(name) }
  if (status !== undefined) { sets.push('status = ?'); vals.push(status === 'active' ? 'active' : 'disabled') }
  if (quotaLimit !== undefined) { sets.push('quota_limit = ?'); vals.push(quotaLimit && quotaLimit > 0 ? quotaLimit : null) }
  if (sets.length === 0) return true
  vals.push(id, userId)
  db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals)
  return true
}

/** 删除 key（仅本人）。返回是否命中。 */
export function deleteApiKey(id, userId) {
  const r = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId)
  return r.changes > 0
}

/** 记录一次 key 使用：request_count +1、last_used 更新、可选累加 quota_used。 */
export function touchApiKeyUsage(id, costQuota = 0) {
  db.prepare(`UPDATE api_keys SET request_count = request_count + 1, last_used_at = ?,
    quota_used = quota_used + ? WHERE id = ?`).run(Date.now(), Math.max(0, costQuota || 0), id)
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
