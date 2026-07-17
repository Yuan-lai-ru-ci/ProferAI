/**
 * Admin 兑换码管理路由 — 生成兑换码，用户可兑换额度/套餐/VIP
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { createRedemptionCode, listRedemptionCodes } from '../../db.js'
import { logAudit } from '../../audit.js'

export const adminRedemptionCodes = new Hono()

// POST /v1/admin/redemption-codes — 生成兑换码
adminRedemptionCodes.post('/', async (c) => {
  const body = await c.req.json()
  const { count = 1, type, value, cycle = 'monthly', expiresInDays } = body || {}

  if (!type || !['credits', 'plan', 'vip'].includes(type)) {
    return c.json({ error: 'type 必须是 credits / plan / vip' }, 400)
  }
  if (!value) {
    return c.json({ error: 'value 必填（credits: 积分数, plan: standard/plus/pro, vip: vip）' }, 400)
  }
  if (type === 'plan' && !['standard', 'plus', 'pro'].includes(value)) {
    return c.json({ error: 'plan 的 value 必须是 standard / plus / pro' }, 400)
  }

  const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86400 * 1000 : null
  const codes = []

  for (let i = 0; i < Math.min(count, 100); i++) {
    const code = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()
    const result = createRedemptionCode({ code, type, value, cycle, createdBy: c.get('userId'), expiresAt })
    codes.push(result)
  }

  const typeLabel = { credits: '额度', plan: '套餐', vip: 'VIP' }[type]
  logAudit({ action: 'admin.create_redemption_codes', userId: c.get('userId'), userEmail: c.get('userEmail'), detail: `count=${codes.length} type=${type} value=${value} (${typeLabel})` })
  return c.json({ codes, type, value, cycle }, 201)
})

// GET /v1/admin/redemption-codes — 列出兑换码
adminRedemptionCodes.get('/', (c) => {
  const status = c.req.query('status') || undefined
  const type = c.req.query('type') || undefined
  const codes = listRedemptionCodes({ status, type })
  return c.json(codes)
})
