/**
 * New API 对账客户端
 *
 * 单一计费真源：不在 Profer 侧复现 New API 的计费公式（实测公式不可靠——
 * 自定义定价/按次计费会让本地估算与 New API 实扣差几十倍）。改为转发后用
 * New API 回传的 request_id（响应头 x-oneapi-request-id）去查 New API 的日志，
 * 读它**实际扣的 quota**，作为唯一计费依据。
 *
 * Profer 对用户扣费 = New API 实扣 quota / QUOTA_PER_UNIT × BILLING_MARKUP。
 * New API 是计量表，Profer 本地账本是其忠实镜像 × 加价，笔笔对应、零漂移。
 */
import crypto from 'crypto'
import {
  RELAY_BASE_URL,
  NEWAPI_ADMIN_TOKEN,
  NEWAPI_ADMIN_USER_ID,
  NEWAPI_QUOTA_PER_UNIT,
  BILLING_MARKUP,
} from './config.js'

/** New API 响应里携带其内部 request_id 的头（用于对账查日志）。 */
export const NEWAPI_REQUEST_ID_HEADER = 'x-oneapi-request-id'

/** 从上游响应头提取 New API request_id；无则返回 null。 */
export function extractNewApiRequestId(resp) {
  try {
    return resp?.headers?.get?.(NEWAPI_REQUEST_ID_HEADER) || null
  } catch {
    return null
  }
}

/** 带系统令牌的管理接口 GET 请求。失败返回 { ok:false }，绝不抛（计费链不能因对账失败崩）。 */
async function adminGet(path, { timeoutMs = 8000 } = {}) {
  if (!NEWAPI_ADMIN_TOKEN) return { ok: false, reason: 'no_admin_token' }
  try {
    const resp = await fetch(`${RELAY_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${NEWAPI_ADMIN_TOKEN}`,
        'New-API-User': String(NEWAPI_ADMIN_USER_ID),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    // New API 鉴权失败返回 HTTP 200 + {success:false}，必须看 success 字段。
    if (json && json.success === false) {
      return { ok: false, reason: json.message || 'api_error', raw: text.slice(0, 200) }
    }
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}`, raw: text.slice(0, 200) }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/** 带系统令牌的管理接口 POST 请求。失败返回 { ok:false }，绝不抛。 */
async function adminPost(path, body, { timeoutMs = 8000 } = {}) {
  if (!NEWAPI_ADMIN_TOKEN) return { ok: false, reason: 'no_admin_token' }
  try {
    const resp = await fetch(`${RELAY_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NEWAPI_ADMIN_TOKEN}`,
        'New-API-User': String(NEWAPI_ADMIN_USER_ID),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    if (json && json.success === false) {
      return { ok: false, reason: json.message || 'api_error', raw: text.slice(0, 200) }
    }
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}`, raw: text.slice(0, 200) }
    return { ok: true, json }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/**
 * 按 New API request_id 查它实际扣的 quota。
 *
 * New API 日志是异步写的，转发刚结束时可能还没落库 → 带重试。
 * @returns {Promise<{found:boolean, quota?:number, promptTokens?:number, completionTokens?:number, model?:string}>}
 */
export async function fetchActualQuotaByRequestId(requestId, { retries = 4, retryDelayMs = 400 } = {}) {
  if (!requestId) return { found: false }
  let lastReason = ''
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await adminGet(`/api/log/?p=0&page_size=1&request_id=${encodeURIComponent(requestId)}`)
    if (r.ok) {
      const item = r.json?.data?.items?.[0]
      if (item) {
        return {
          found: true,
          quota: Number(item.quota) || 0,
          promptTokens: Number(item.prompt_tokens) || 0,
          completionTokens: Number(item.completion_tokens) || 0,
          model: item.model_name || '',
        }
      }
      // ok 但 items 为空 → 日志确实还没写好
      lastReason = 'not_logged_yet'
    } else {
      lastReason = r.reason || 'unknown'
      // 不可恢复的错误，重试也没用，直接返回具体原因
      if (r.reason === 'no_admin_token') return { found: false, reason: 'no_admin_token' }
      if (r.reason && /unauthorized|auth|login/i.test(r.reason)) return { found: false, reason: `auth_failed: ${r.reason}` }
    }
    if (attempt < retries) await new Promise((res) => setTimeout(res, retryDelayMs))
  }
  return { found: false, reason: lastReason || 'not_logged_yet' }
}

/** New API quota → Profer 扣费额度（货币单位 × 加价）。用于展示/对外金额。 */
export function quotaToBilledCost(quota) {
  if (!quota || quota <= 0) return 0
  const costUnit = quota / NEWAPI_QUOTA_PER_UNIT
  return costUnit * BILLING_MARKUP
}

/**
 * New API quota → Profer 本地账本扣减额度（整数 quota 单位 × 加价，向上取整）。
 *
 * Profer 本地 credits 账本与 New API 同单位（quota，整数），避免浮点累积误差，
 * 也便于和 New API 实扣对账（1:1 × markup）。余额→货币展示时再 ÷ QUOTA_PER_UNIT。
 */
export function quotaToBilledCredits(quota) {
  if (!quota || quota <= 0) return 0
  return Math.ceil(quota * BILLING_MARKUP)
}

/**
 * 对账一次请求：按 request_id 拿真实 quota，换算成 Profer 扣费额度。
 * @returns {Promise<{billedCredits:number, billedCost:number, quota:number, found:boolean, reason?:string}>}
 */
export async function reconcileRequestCost(newApiRequestId) {
  const r = await fetchActualQuotaByRequestId(newApiRequestId)
  if (!r.found) return { billedCredits: 0, billedCost: 0, quota: 0, found: false, reason: r.reason }
  return {
    billedCredits: quotaToBilledCredits(r.quota),
    billedCost: quotaToBilledCost(r.quota),
    quota: r.quota,
    found: true,
  }
}

// ===== Phase 1: New API 用户 & Token 管理 =====

/**
 * 在 New API 创建用户。
 *
 * NewAPI POST /api/user/ 需要 username + password（必填），返回 {success:true}
 * 但不包含 data.id。因此创建后需通过 SQLite 查询获取实际 ID。
 *
 * @returns {Promise<{ok:boolean, userId?:number, error?:string}>}
 */
/**
 * 将 Profer 邮箱转为 NewAPI username（最长 15 字符，超长取前缀+hash）。
 * @param {string} email
 * @returns {string}
 */
function toNewApiUsername(email) {
  if (email.length <= 15) return email
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 4)
  return email.slice(0, 10) + hash
}

export async function createNewApiUser(email, displayName) {
  // NewAPI 要求必传 password（8-20字符）；用户通过 Profer 鉴权，不需要知道此密码
  const password = crypto.randomBytes(8).toString('hex')
  const username = toNewApiUsername(email)
  const r = await adminPost('/api/user/', {
    username,
    password,
    display_name: (displayName || email.split('@')[0]).slice(0, 20),
  })
  if (!r.ok) return { ok: false, error: r.reason }

  // NewAPI 不返回用户 ID，需通过 SQLite 查询（用转换后的 username）
  const userId = await findNewApiUserIdByUsername(username)
  if (!userId) return { ok: false, error: 'no_user_id_in_response' }
  return { ok: true, userId }
}

/**
 * 通过 username 在 NewAPI SQLite 中查找用户 ID。
 * @param {string} username
 * @returns {Promise<number|null>}
 */
async function findNewApiUserIdByUsername(username) {
  let db
  try {
    db = await _openNewApiDb()
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
    return row?.id || null
  } catch {
    return null
  } finally {
    if (db) db.close()
  }
}

/**
 * 为 New API 用户生成 API Key（sk-...）。
 * @returns {Promise<{ok:boolean, key?:string, error?:string}>}
 */
export async function generateNewApiToken(newApiUserId) {
  const r = await adminPost('/api/token/', {
    user_id: newApiUserId,
    name: 'Profer Auto',
    remain_quota: 0, // 额度由 Profer 侧管理，不从 New API 划拨
    expired_time: -1, // 永不过期
  })
  if (!r.ok) return { ok: false, error: r.reason }
  const key = r.json?.data?.key
  if (!key) return { ok: false, error: 'no_key_in_response' }
  return { ok: true, key }
}

// ===== Phase 2: 每用户独立 New API Key =====

/**
 * 获取 New API SQLite 数据库连接。
 * 与 maintainAbilitiesTable 同模式：直接打开共享 volume 上的 DB 文件。
 * @returns {Promise<import('better-sqlite3').Database>}
 */
async function _openNewApiDb() {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3')
  return new Database('/app/new-api-data/one-api.db', { readonly: false })
}

/**
 * 生成 48 字符随机 API Key。
 * 纯 hex，无前缀——SQLite 直接插入后立即可用，无需重启 New API。
 * 不可用 sk- 前缀（New API 对其有特殊内存缓存解析）。
 * @returns {string}
 */
export function generateTokenKey() {
  return crypto.randomBytes(24).toString('hex')
}

/**
 * 通过 SQLite 直接向 New API 插入推理用 API Key。
 *
 * New API 的 REST API 无法创建可用于推理的 Key：
 * - POST /api/token/ 生成的是管理用 token（18 字符），不能调推理 API
 * - Web UI 创建的 sk- 格式 Key 有特殊内存缓存，SQL 插入不生效
 *
 * 因此绕过 API 直接写 DB（与 maintainAbilitiesTable 同模式）。
 * 48 字符纯 hex token 插入后立即可用，无需重启 New API。
 *
 * @param {number} newApiUserId
 * @param {string} tokenKey
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function insertNewApiToken(newApiUserId, tokenKey) {
  let db
  try {
    db = await _openNewApiDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, \`group\`)
       VALUES (?, ?, 1, 'profer-auto', ?, ?, -1, 0, 1, 'default')`
    ).run(newApiUserId, tokenKey, now, now)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (db) db.close()
  }
}

/**
 * 通过 SQLite 直接设置 New API 用户的额度。
 *
 * 不能用 PUT /api/user/ 设额度——该接口无论是否带 password 字段都会破坏用户密码。
 * 因此绕过 API 直接写 DB（与 insertNewApiToken 同模式）。
 *
 * @param {number} newApiUserId
 * @param {number} quota - New API quota 单位（500000 = $1）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function setNewApiUserQuota(newApiUserId, quota) {
  let db
  try {
    db = await _openNewApiDb()
    db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(quota, newApiUserId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (db) db.close()
  }
}

/**
 * 一站式创建 New API 用户 + 设额度 + 生成 API Key。
 * 注册和存量迁移的统一入口。
 *
 * @param {string} email
 * @param {string} displayName
 * @param {number} initialQuota - 初始额度（New API quota 单位，500000 = $1）
 * @returns {Promise<{ok:boolean, userId?:number, tokenKey?:string, error?:string}>}
 */
export async function provisionNewApiUser(email, displayName, initialQuota) {
  // 0. 检查用户是否已存在（幂等：前次可能只创建了用户但 token 未写入）
  const username = toNewApiUsername(email)
  let userId = await findNewApiUserIdByUsername(username)

  if (!userId) {
    // 1. 创建 New API 用户
    const userR = await createNewApiUser(email, displayName)
    if (!userR.ok) return { ok: false, error: `创建用户失败: ${userR.error}` }
    userId = userR.userId
  }

  // 2. 设额度
  const quotaR = await setNewApiUserQuota(userId, initialQuota)
  if (!quotaR.ok) return { ok: false, error: `设额度失败: ${quotaR.error}`, userId }

  // 3. 生成并插入 token（每次调用都生成新 token）
  const tokenKey = generateTokenKey()
  const tokenR = await insertNewApiToken(userId, tokenKey)
  if (!tokenR.ok) return { ok: false, error: `插入 token 失败: ${tokenR.error}`, userId }

  return { ok: true, userId, tokenKey }
}

// ===== Phase 3: New API 用户清理 & Key 轮换 =====

/**
 * 禁用 New API 用户的所有推理 Token。
 *
 * 不删用户（New API 无删除用户的 REST API），只禁用 Token 使其无法继续调用。
 * 通过 SQLite 直接写，fire-and-forget——失败不影响 Profer 侧用户删除。
 *
 * @param {number} newApiUserId
 * @returns {Promise<{ok:boolean, disabledCount?:number, error?:string}>}
 */
export async function disableNewApiTokens(newApiUserId) {
  let db
  try {
    db = await _openNewApiDb()
    const result = db.prepare(
      "UPDATE tokens SET status = 0 WHERE user_id = ? AND status = 1 AND name = 'profer-auto'"
    ).run(newApiUserId)
    return { ok: true, disabledCount: result.changes }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (db) db.close()
  }
}

/**
 * 轮换用户的 New API Key：禁用旧 Key，生成新 Key。
 *
 * @param {number} newApiUserId - New API 侧的用户 ID
 * @param {string|null} oldTokenKey - 旧的 token key（如果知道的话，精准禁用；否则批量禁用所有 profer-auto token）
 * @returns {Promise<{ok:boolean, newTokenKey?:string, error?:string}>}
 */
export async function rotateNewApiToken(newApiUserId, oldTokenKey) {
  let db
  try {
    db = await _openNewApiDb()
    const now = Math.floor(Date.now() / 1000)

    // 1. 禁用旧 Token
    if (oldTokenKey) {
      db.prepare("UPDATE tokens SET status = 0 WHERE user_id = ? AND key = ?")
        .run(newApiUserId, oldTokenKey)
    } else {
      // 不知道旧 Key 时，批量禁用该用户所有 profer-auto token
      db.prepare("UPDATE tokens SET status = 0 WHERE user_id = ? AND status = 1 AND name = 'profer-auto'")
        .run(newApiUserId)
    }

    // 2. 生成新 Token 并插入
    const newTokenKey = generateTokenKey()
    db.prepare(
      `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, \`group\`)
       VALUES (?, ?, 1, 'profer-auto', ?, ?, -1, 0, 1, 'default')`
    ).run(newApiUserId, newTokenKey, now, now)

    return { ok: true, newTokenKey }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (db) db.close()
  }
}
