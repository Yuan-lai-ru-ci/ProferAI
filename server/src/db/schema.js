import Database from 'better-sqlite3'
import { DB_PATH, ADMIN_EMAIL, ADMIN_PASSWORD, DEFAULT_CREDIT_GRANT } from '../config.js'
import { hashPassword } from '../utils.js'
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