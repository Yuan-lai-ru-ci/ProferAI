/**
 * Admin 额度管理路由
 */
import { Hono } from 'hono'
import { getCredits, grantCredits, getCreditTransactions, getCreditSummary } from '../../db.js'
import { logAudit } from '../../audit.js'

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
