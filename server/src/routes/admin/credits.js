/**
 * Admin 额度管理路由
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getCredits, grantCredits, getCreditTransactions, getCreditSummary, getRequestLogs, getUsageByModel, listAllUsers, ensureCreditRow, db } from '../../db.js'
import { logAudit } from '../../audit.js'
import { MAX_GRANT_AMOUNT, getAccountCapability, NEWAPI_QUOTA_PER_UNIT } from '../../config.js'

export const adminCredits = new Hono()

// GET /v1/admin/credits/summary — 额度汇总统计
adminCredits.get('/summary', (c) => {
  const summary = getCreditSummary()
  return c.json(summary)
})

// POST /v1/admin/credits/grant — 手动充值
adminCredits.post('/grant', async (c) => {
  const body = await c.req.json()
  const { userId, amount, description } = body || {}
  if (!userId || !amount || amount <= 0) return c.json({ error: 'userId 和 amount(>0) 必填' }, 400)
  if (amount > MAX_GRANT_AMOUNT) return c.json({ error: `单次充值不能超过 ${MAX_GRANT_AMOUNT} credits，当前输入 ${amount}` }, 400)

  grantCredits(c.get('userId'), userId, amount, description || '管理员手动充值')
  const credits = getCredits(userId)

  logAudit({ action: 'admin.grant_credits', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'user', entityId: userId, detail: `granted ${amount}, new balance: ${credits?.balance}` })
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

/** 各账号类型的重置额度（美元） */
const RESET_AMOUNT_USD = { restricted: 1, standard: 5, advanced: 15 }

// GET /v1/admin/credits/reset-preview — 预览批量充值的用户和金额
adminCredits.get('/reset-preview', (c) => {
  const qpu = NEWAPI_QUOTA_PER_UNIT
  const result = listAllUsers({ search: '', page: 1, limit: 9999 })
  const users = (result.users || []).map((u) => {
    const type = u.account_type === 'team' ? 'standard' : (u.account_type || 'standard')
    const resetUsd = RESET_AMOUNT_USD[type] || RESET_AMOUNT_USD.standard
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      accountType: type,
      currentBalance: u.credit_balance || 0,
      currentBalanceUSD: ((u.credit_balance || 0) / qpu).toFixed(2),
      resetAmountQuota: resetUsd * qpu,
      resetAmountUSD: resetUsd.toFixed(2),
    }
  })
  return c.json({ users })
})

// POST /v1/admin/credits/batch-reset — 批量重置用户额度为账号类型默认值
adminCredits.post('/batch-reset', async (c) => {
  const body = await c.req.json()
  const { userIds } = body || {}
  const qpu = NEWAPI_QUOTA_PER_UNIT
  const adminId = c.get('userId')

  // 确定目标用户：传了 userIds 就只重置那些，否则全部用户
  const allUsers = listAllUsers({ search: '', page: 1, limit: 9999 }).users || []
  const targetSet = userIds && userIds.length > 0 ? new Set(userIds) : null
  const targets = allUsers.filter((u) => !targetSet || targetSet.has(u.id))

  if (targets.length === 0) return c.json({ error: '没有匹配的用户' }, 400)

  const now = Date.now()
  const results = []

  const tx = db.transaction(() => {
    for (const u of targets) {
      const type = u.account_type === 'team' ? 'standard' : (u.account_type || 'standard')
      const resetUsd = RESET_AMOUNT_USD[type] || RESET_AMOUNT_USD.standard
      const resetQuota = resetUsd * qpu
      const oldBalance = u.credit_balance || 0

      ensureCreditRow(u.id)
      db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?')
        .run(resetQuota, now, u.id)
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
