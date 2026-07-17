/**
 * 兑换码路由 — 用户输入兑换码兑换额度/套餐/VIP
 */
import { Hono } from 'hono'
import { validateRedemptionCode, redeemCode } from '../../db.js'
import { logAudit } from '../../audit.js'

export const accountRedeem = new Hono()

// POST /v1/account/redeem — 兑换
accountRedeem.post('/', async (c) => {
  const body = await c.req.json()
  const { code } = body || {}

  if (!code || typeof code !== 'string' || !code.trim()) {
    return c.json({ error: '请输入兑换码' }, 400)
  }

  const trimmed = code.trim().toUpperCase()

  // 验证兑换码
  const validation = validateRedemptionCode(trimmed)
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400)
  }

  const userId = c.get('userId')

  try {
    const result = redeemCode(userId, validation)
    logAudit({
      action: 'user.redeem_code',
      userId,
      userEmail: c.get('userEmail'),
      detail: `code=${trimmed} type=${validation.type} value=${validation.value} → ${result.description}`,
    })
    return c.json({ success: true, description: result.description })
  } catch (e) {
    if (e.message === 'CODE_ALREADY_USED') {
      return c.json({ error: '兑换码已被使用' }, 409)
    }
    if (e.message === 'ALREADY_VIP') {
      return c.json({ error: '您已经是 VIP 会员' }, 409)
    }
    if (e.message === 'INVALID_CREDITS_VALUE' || e.message === 'INVALID_PLAN' || e.message === 'INVALID_REDEMPTION_TYPE') {
      return c.json({ error: '兑换码配置有误，请联系管理员' }, 500)
    }
    throw e
  }
})
