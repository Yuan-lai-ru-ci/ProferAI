/**
 * Admin 额度管理路由
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getCredits, grantCredits, getCreditTransactions, getCreditSummary, getRequestLogs, getUsageByModel, listAllUsers, resetCreditBalance, db, getConfig } from '../../db.js'
import { logAudit } from '../../audit.js'
import { NEWAPI_QUOTA_PER_UNIT, MAX_BATCH_RESET_SIZE, MAX_BATCH_RESET_PER_DAY } from '../../config.js'
import { adminOpLimit, ADMIN_OP_LIMITS } from '../../admin-rate-limiter.js'

function dailyGrantCap() { return getConfig('admin.dailyGrantCap') }
function maxGrantAmount() { return getConfig('admin.maxGrantAmount') }

function parsePositiveQuota(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

export const adminCredits = new Hono()

// GET /v1/admin/credits/summary — 额度汇总统计
adminCredits.get('/summary', (c) => {
  const summary = getCreditSummary()
  return c.json(summary)
})

// POST /v1/admin/credits/grant — 手动充值（带日额度上限）
adminCredits.post('/grant', async (c) => {
  const body = await c.req.json()
  const { userId, amount: rawAmount, description } = body || {}
  const amount = parsePositiveQuota(rawAmount)
  if (!userId || amount === null) return c.json({ error: 'userId 和 amount(正安全整数) 必填', code: 'INVALID_GRANT_AMOUNT' }, 400)
  if (amount > maxGrantAmount()) return c.json({ error: `单次充值不能超过 ${maxGrantAmount()} credits，当前输入 ${amount}` }, 400)

  const adminId = c.get('userId')

  // 频控检查
  const freqLimit = adminOpLimit(adminId, 'grant-credits', ADMIN_OP_LIMITS['grant-credits'])
  if (!freqLimit.allowed) {
    return c.json({ error: '今日充值次数已达上限，请明天再试' }, 429)
  }

  // 日充值总额度检查
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const dailyTotal = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM credit_transactions WHERE reference_id = ? AND type = ? AND reference_type = ? AND created_at > ?'
  ).get(adminId, 'grant', 'admin_grant', todayStart).total
  if (dailyTotal + amount > dailyGrantCap()) {
    return c.json({ error: `今日充值总额已达上限 (${dailyGrantCap()} quota)` }, 403)
  }

  grantCredits(adminId, userId, amount, description || '管理员手动充值')
  const credits = getCredits(userId)

  logAudit({ action: 'admin.grant_credits', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: userId, detail: `granted ${amount}, new balance: ${credits?.balance}` })
  return c.json({ success: true, balance: credits?.balance })
})

// GET /v1/admin/credits/transactions — 交易流水
adminCredits.get('/transactions', (c) => {
  const userId = c.req.query('userId') || undefined
  const type = c.req.query('type') || undefined
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
  const result = getCreditTransactions({ userId, type, page, limit })
  return c.json(result)
})

// GET /v1/admin/credits/request-logs — 请求日志
adminCredits.get('/request-logs', (c) => {
  const userId = c.req.query('userId') || undefined
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
  const result = getRequestLogs({ userId, page, limit })
  return c.json(result)
})

// GET /v1/admin/credits/usage-by-model — 按模型用量统计
adminCredits.get('/usage-by-model', (c) => {
  const days = parseInt(c.req.query('days') || '30', 10)
  const result = getUsageByModel({ days })
  return c.json(result)
})

/** 各订阅等级的重置额度（美元） */
const RESET_AMOUNT_USD = { free: 1, standard: 5, plus: 10, pro: 15 }

// GET /v1/admin/credits/reset-preview — 预览批量充值的用户和金额
adminCredits.get('/reset-preview', (c) => {
  const qpu = NEWAPI_QUOTA_PER_UNIT
  const result = listAllUsers({ search: '', page: 1, limit: 9999 })
  const users = (result.users || []).map((u) => {
    const type = u.membership_tier || 'free'
    const resetUsd = RESET_AMOUNT_USD[type] || RESET_AMOUNT_USD.free
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      membershipTier: type,
      currentBalance: u.credit_balance || 0,
      currentBalanceUSD: ((u.credit_balance || 0) / qpu).toFixed(2),
      resetAmountQuota: resetUsd * qpu,
      resetAmountUSD: resetUsd.toFixed(2),
    }
  })
  return c.json({ users })
})

// POST /v1/admin/credits/batch-reset — 批量重置用户额度为账号类型默认值
// 🔒 安全加固：必须显式传 userIds、单批上限 50、每 admin 每天最多 3 次、保留 lifetime_consumed
adminCredits.post('/batch-reset', async (c) => {
  const body = await c.req.json()
  const { userIds } = body || {}
  const qpu = NEWAPI_QUOTA_PER_UNIT
  const adminId = c.get('userId')

  // Guard 1: 必须显式指定 userIds（不允许空列表=全部用户）
  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
    return c.json({ error: '必须指定要重置的用户 ID 列表 (userIds)，不允许重置全部用户' }, 400)
  }

  // Guard 2: 单批上限
  if (userIds.length > MAX_BATCH_RESET_SIZE) {
    return c.json({ error: `单次批量重置最多 ${MAX_BATCH_RESET_SIZE} 个用户，当前传入 ${userIds.length}` }, 400)
  }

  // Guard 3: 每 admin 每天次数限制
  const freqLimit = adminOpLimit(adminId, 'batch-reset', ADMIN_OP_LIMITS['batch-reset'])
  if (!freqLimit.allowed) {
    return c.json({ error: `今日批量重置次数已达上限 (${MAX_BATCH_RESET_PER_DAY} 次)，请明天再试` }, 429)
  }

  const allUsers = listAllUsers({ search: '', page: 1, limit: 9999 }).users || []
  const targetSet = new Set(userIds)
  const targets = allUsers.filter((u) => targetSet.has(u.id))

  if (targets.length === 0) return c.json({ error: '没有匹配的用户' }, 400)

  const now = Date.now()
  const results = []

  const tx = db.transaction(() => {
    for (const u of targets) {
      const type = u.membership_tier || 'free'
      const resetUsd = RESET_AMOUNT_USD[type] || RESET_AMOUNT_USD.free
      const resetQuota = resetUsd * qpu
      const oldBalance = u.credit_balance || 0

      // 保留 lifetime_consumed（不归零），只设新余额。
      // 三桶才是真账本；resetCreditBalance 会同步镜像，避免下一次扣款覆盖重置结果。
      resetCreditBalance(u.id, resetQuota, now)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'admin_grant', ?, 'admin_reset', ?, ?)`)
        .run(uuidv4(), u.id, resetQuota,
          `管理员重置额度：${type} → $${resetUsd}（${resetQuota} quota）`,
          adminId, now)

      results.push({
        id: u.id,
        email: u.email,
        type,
        oldBalance,
        oldBalanceUSD: (oldBalance / qpu).toFixed(2),
        newBalance: resetQuota,
        newBalanceUSD: resetUsd.toFixed(2),
      })
    }
  })
  tx()

  logAudit({
    action: 'admin.batch_reset_credits',
    userId: adminId,
    userEmail: c.get('userEmail'),
    entityType: 'user',
    detail: `批量重置 ${results.length} 个用户额度：${results.map((r) => `${r.email}→$${r.newBalanceUSD}`).join(', ')}`,
  })

  return c.json({ success: true, count: results.length, results })
})
