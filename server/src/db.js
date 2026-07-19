/**
 * 数据库模块 — barrel 入口
 *
 * 子模块：
 *   db/schema.js      — db 实例 + 建表/迁移 + initAdmin + reserveSyncSeq
 *   db/credits.js     — 积分三桶扣款/透支/交易/对账
 *   db/subscription.js — 订阅/订单/邀请/drip/兑换码
 *   db/config-store.js — 系统配置（套餐定价/计费/VIP/限额）
 *
 * 本文件保留：用户管理、渠道管理、relay 令牌、请求日志、API Keys、仪表盘
 */
import { buildRequestLogInsertSql, buildRequestLogValues } from './request-log-utils.js'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// 从子模块导入并 re-export
export { db, initAdmin, reserveSyncSeq } from './db/schema.js'
export {
  getCredits, ensureCreditRow, grantCredits, refundCredits,
  deductCredits, syncCreditBalance, resetCreditBalance, pointsToQuota,
  getCreditTransactions, getCreditSummary,
} from './db/credits.js'
export {
  createInviteCode, getInviterByCode, getUserInviteCode, getUserInvitees, recordInviteEvent,
  createOrder, confirmOrder, expireOrder, listOrders, getOrder, getExpectedSubscriptionAmountRmb,
  getActiveSubscription, getSubscriptionStatus,
  destroySubscription, freezeSubscription, unfreezeSubscription, upgradeSubscription, expireSubscription,
  accrueDailyDrip, accrueDailyDripForUser, claimDrip, clearWeeklyDrip, getChinaDate, getChinaWeekStart,
  createActivationCode, listActivationCodes, validateActivationCode, useActivationCode,
  createRedemptionCode, listRedemptionCodes, validateRedemptionCode, markRedemptionCodeUsed, redeemCode,
} from './db/subscription.js'
export {
  getConfig, getConfigs, getConfigsGrouped, setConfig, setConfigs, resetConfig,
  getPlanDefs, getPlanDefsRedeem, getVipConfig, getBillingConfig, CONFIG_SCHEMA,
} from './db/config-store.js'

// 从子模块导入内部使用的函数
import { db } from './db/schema.js'
import { deductCredits, ensureCreditRow, syncCreditBalance, getCreditSummary } from './db/credits.js'
import { getBillingConfig } from './db/config-store.js'
import { DEFAULT_CREDIT_GRANT } from './config.js'

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

/** 认证中间件使用的最小实时授权投影，禁止泄露用户敏感列。 */
export function getCurrentUserAuthorization(userId) {
  if (!userId || typeof userId !== 'string') return undefined
  return db.prepare(`
    SELECT id, email, is_admin, is_suspended, membership_tier
    FROM users WHERE id = ?
  `).get(userId)
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
  const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1').get().cnt
  if (adminCount <= 1) throw new Error('CANNOT_DEMOTE_LAST_ADMIN')
  return db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(userId)
}

/** 彻底删除用户及其关联数据 */
export function deleteUser(userId) {
  const target = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId)
  if (target?.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1').get().cnt
    if (adminCount <= 1) throw new Error('CANNOT_DELETE_LAST_ADMIN')
  }
  const tx = db.transaction(() => {
    const ownedWorkspaces = db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(userId)
    for (const ws of ownedWorkspaces) {
      db.prepare('DELETE FROM file_manifests WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM sync_envelopes WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM invitations WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM announcements WHERE workspace_id = ?').run(ws.id)
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(ws.id)
    }
    db.prepare('DELETE FROM workspaces WHERE owner_id = ?').run(userId)
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
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })
  tx()
  return true
}

// ===== Relay 令牌 =====

function generateRelayToken() {
  return `prelay_${crypto.randomBytes(32).toString('hex')}`
}

export function ensureRelayToken(userId) {
  const row = db.prepare('SELECT relay_token FROM users WHERE id = ?').get(userId)
  if (row?.relay_token) return row.relay_token
  const token = generateRelayToken()
  db.prepare('UPDATE users SET relay_token = ? WHERE id = ?').run(token, userId)
  return token
}

export function rotateRelayToken(userId) {
  const token = generateRelayToken()
  db.prepare('UPDATE users SET relay_token = ? WHERE id = ?').run(token, userId)
  return token
}

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

// ===== 请求日志 =====

/** 记录一次 API 代理请求 */
export function logRequest(params) {
  return db.prepare(buildRequestLogInsertSql()).run(...buildRequestLogValues(params))
}

/**
 * 扣费循环：扫描未扣费的成功请求，按 New API request_id 补扣。
 */
export async function sweepUnbilledRequests({ batchSize = 100, maxAgeMs = 86400_000 * 7, minAgeMs = 120_000 } = {}) {
  const cutoff = Date.now() - maxAgeMs
  const minCreatedAt = Date.now() - minAgeMs
  const rows = db.prepare(`
    SELECT id, user_id, new_api_request_id, created_at, billing_markup
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
      const billing = Number.isFinite(row.billing_markup) && row.billing_markup > 0
        ? { markup: row.billing_markup }
        : getBillingConfig()
      if (billing.markup !== row.billing_markup) console.warn(`[sweep] request_log=${row.id} 缺少计价快照，使用 legacy 当前 markup`)
      const rec = await reconcileRequestCost(row.new_api_request_id, billing)
      if (!rec.found || rec.billedCredits <= 0) {
        skipped++
        if (!rec.found && Date.now() - row.created_at > 86400_000 * 4) {
          db.prepare('UPDATE request_logs SET cost_credits = -1 WHERE id = ?').run(row.id)
        }
        continue
      }
      deductCredits(row.user_id, rec.billedCredits, {
        description: `后台补扣（New API quota ${rec.quota}）`,
        referenceType: 'api_call_sweep',
        referenceId: row.id,
        force: true,
      })
      updateRequestLogCost(row.id, rec.billedCredits, { actualQuota: rec.quota, billingMarkup: billing.markup })
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

/** 更新单条请求日志的扣费额度 */
export function updateRequestLogCost(requestId, costCredits, { actualQuota = null, billingMarkup = null } = {}) {
  db.prepare('UPDATE request_logs SET cost_credits = ?, actual_quota = ?, billing_markup = ? WHERE id = ?')
    .run(costCredits, actualQuota, billingMarkup, requestId)
}

/** 根据实际用量调整已扣额度 */
export function adjustCreditDeduction(userId, oldAmount, newAmount, referenceId) {
  const diff = oldAmount - newAmount
  if (diff === 0) return
  const now = Date.now()
  const tx = db.transaction(() => {
    if (diff > 0) {
      db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?').run(diff, userId)
      db.prepare('UPDATE credits SET balance = balance + ?, lifetime_consumed = MAX(0, lifetime_consumed - ?), updated_at = ? WHERE user_id = ?')
        .run(diff, diff, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'refund', ?, 'balance_purchased', 'api_adjust', ?, ?)`)
        .run(uuidv4(), userId, diff, `实际用量调整：退还 ${diff} credits`, referenceId, now)
    } else {
      const extra = -diff
      db.prepare('UPDATE users SET balance_purchased = balance_purchased - ? WHERE id = ?').run(extra, userId)
      db.prepare('UPDATE credits SET balance = MAX(0, balance - ?), lifetime_consumed = lifetime_consumed + ?, updated_at = ? WHERE user_id = ?')
        .run(extra, extra, now, userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'consumption', ?, 'balance_purchased', 'api_adjust', ?, ?)`)
        .run(uuidv4(), userId, -extra, `实际用量调整：补扣 ${extra} credits`, referenceId, now)
    }
  })
  tx()
}

function usageLogsCte() {
  return `
    WITH usage_logs AS (
      SELECT id, user_id, model, provider, prompt_tokens, completion_tokens, total_tokens,
             cache_creation_tokens, cache_read_tokens, cost_credits, duration_ms, success,
             stream, error_message, created_at, 0 as historical
      FROM request_logs
    )
  `
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

// ===== 开放 API：用户 API Key 管理 =====

function generateApiKey() {
  return `pk_${crypto.randomBytes(32).toString('hex')}`
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function getApiKeyOwned(id, userId) {
  return db.prepare('SELECT id FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId)
}

/** 创建一把 API Key。返回 { id, plaintext, prefix }——plaintext 只此一次可见。 */
export function createApiKey({ userId, name = '', quotaLimit = null }) {
  const id = uuidv4()
  const plaintext = generateApiKey()
  const keyHash = hashApiKey(plaintext)
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

/** 按 hash 反查 key 记录（proxy 鉴权用）。 */
export function getApiKeyByHash(keyHash) {
  if (!keyHash) return undefined
  return db.prepare(`SELECT ak.id, ak.user_id, ak.status, ak.quota_limit, ak.quota_used,
           u.id AS authorization_user_id, u.email, u.is_admin, u.is_suspended, u.membership_tier
    FROM api_keys ak JOIN users u ON u.id = ak.user_id
    WHERE ak.key_hash = ?`).get(keyHash)
}

/** 更新 key 的名称 / 状态 / 限额（仅本人）。 */
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

/** 删除 key（仅本人）。 */
export function deleteApiKey(id, userId) {
  const r = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId)
  return r.changes > 0
}

/** 记录一次 key 使用。 */
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
