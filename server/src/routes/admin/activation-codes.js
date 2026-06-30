/**
 * Admin 激活码管理路由 — 生成个人用户注册用的激活码
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { createActivationCode, listActivationCodes } from '../../db.js'
import { logAudit } from '../../audit.js'

export const adminActivationCodes = new Hono()

// POST /v1/admin/activation-codes — 生成激活码（可指定账号类型）
adminActivationCodes.post('/', async (c) => {
  const body = await c.req.json()
  const { count = 1, expiresInDays, accountType = 'standard' } = body || {}

  const expiresAt = expiresInDays ? Date.now() + expiresInDays * 86400 * 1000 : null
  const codes = []

  for (let i = 0; i < Math.min(count, 100); i++) {
    const code = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()
    const result = createActivationCode({ code, createdBy: c.get('userId'), expiresAt, accountType })
    codes.push(result)
  }

  logAudit({ action: 'admin.create_activation_codes', userId: c.get('userId'), userEmail: c.get('userEmail'), detail: `count=${codes.length} type=${accountType}` })
  return c.json({ codes, accountType }, 201)
})

// GET /v1/admin/activation-codes — 列出激活码
adminActivationCodes.get('/', (c) => {
  const status = c.req.query('status') || undefined
  const codes = listActivationCodes({ status })
  return c.json(codes)
})
