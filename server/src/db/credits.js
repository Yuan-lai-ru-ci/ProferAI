/**
 * 积分/额度操作 — 三桶扣款、透支、交易流水、余额对账
 *
 * 依赖 schema.js 的 db 实例。所有余额操作统一经由此模块。
 * 真账本在 users.balance_package / balance_referral / balance_purchased；
 * credits.balance 是镜像汇总，每次操作后同步。
 */
import { db } from './schema.js'
import { getBillingConfig } from './config-store.js'
import { v4 as uuidv4 } from 'uuid'

// ===== 常量 =====

/** 三桶扣款优先级：balance_package → balance_referral → balance_purchased */
const BUCKET_ORDER = ['balance_package', 'balance_referral', 'balance_purchased']

// ===== 并发锁 =====
// better-sqlite3 同步事务天然原子，锁为未来异步操作预留串行化能力。
const creditLocks = new Map()

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
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (!creditLocks.has(userId)) {
          try {
            const r = runWithLock(userId, fn)
            if (r instanceof Promise) { r.then(resolve, reject) } else { resolve(r) }
          } catch (e) { reject(e) }
        } else {
          setImmediate(poll)
        }
      }
      setImmediate(poll)
    })
  }
  return runWithLock(userId, fn)
}

// ===== 基础 CRUD =====

export function getCredits(userId) {
  return db.prepare('SELECT * FROM credits WHERE user_id = ?').get(userId)
}

/** 确保用户有额度行。统一给默认初始额度（写入 balance_package）。 */
export function ensureCreditRow(userId) {
  const existing = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(userId)
  if (!existing) {
    const grant = getBillingConfig().defaultCreditGrant
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

// ===== 三桶扣款（核心计费逻辑）=====

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
    const effectiveOverdraft = force ? Infinity : getBillingConfig().overdraftLimit
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

/** 同步 credits.balance = 三桶总和（供 subscription/order 模块调用） */
export function syncCreditBalance(userId) {
  const totals = db.prepare('SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?').get(userId)
  if (totals) {
    ensureCreditRow(userId)
    const total = (totals.balance_package || 0) + (totals.balance_referral || 0) + (totals.balance_purchased || 0)
    db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?').run(total, Date.now(), userId)
  }
}

/**
 * 管理员重置额度：三桶是真账本，credits.balance 只是镜像。
 * 重置统一写入 purchased 桶，避免下一次扣款按旧三桶重算时覆盖重置结果。
 */
export function resetCreditBalance(userId, amount, now = Date.now()) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('额度重置金额必须为非负安全整数')
  const tx = db.transaction(() => {
    ensureCreditRow(userId)
    db.prepare('UPDATE users SET balance_package = 0, balance_referral = 0, balance_purchased = ? WHERE id = ?')
      .run(amount, userId)
    db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?').run(amount, now, userId)
  })
  tx()
}

// ===== 交易查询 =====

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

// ===== 工具函数 =====

/** 积分 → quota 换算（1 积分 = 50000 quota） */
export function pointsToQuota(points) {
  return Math.round(points * 50_000)
}
