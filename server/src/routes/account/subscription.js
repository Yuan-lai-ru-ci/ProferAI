/**
 * 套餐订阅路由 — 订阅状态、升级、销毁、drip 领取
 */
import { Hono } from 'hono'
import {
  getSubscriptionStatus,
  destroySubscription,
  claimDrip,
  accrueDailyDripForUser,
} from '../../db.js'

export const accountSubscription = new Hono()

// GET /v1/account/subscription — 当前订阅状态
// 鉴权由 accountApp.use('*', honoAuthMiddleware) 统一处理
accountSubscription.get('/', (c) => {
  const userId = c.get('userId')
  // 与 credits 接口保持一致：仅累计当前用户的待领取池，绝不自动领取。
  accrueDailyDripForUser(userId)
  const status = getSubscriptionStatus(userId)

  if (!status) {
    return c.json({
      hasSubscription: false,
      membershipTier: 'free',
      isVip: false,
      multiplier: 1.0,
    })
  }

  return c.json({ hasSubscription: true, ...status })
})

// POST /v1/account/subscription/claim-drip — 领取本周 drip
accountSubscription.post('/claim-drip', (c) => {
  const userId = c.get('userId')

  // 仅累计当前用户，避免领取请求扫描全站 active subscriptions。
  accrueDailyDripForUser(userId)

  const amount = claimDrip(userId)

  if (amount <= 0) {
    return c.json({ claimed: false, message: '本周暂无待领取的 drip' })
  }

  const points = Math.round(amount / 50_000)
  return c.json({ claimed: true, amount, points, message: `已领取 ${points} 积分` })
})

// POST /v1/account/subscription/destroy — 销毁套餐
accountSubscription.post('/destroy', (c) => {
  const userId = c.get('userId')
  destroySubscription(userId)
  return c.json({ success: true, message: '套餐已销毁，剩余套餐积分仍可使用' })
})

// POST /v1/account/subscription/upgrade — 自助升级入口
// 权益只能在支付确认事务中变更；这里绝不能直接修改 plan / membership_tier。
accountSubscription.post('/upgrade', async (c) => {
  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求体格式错误' }, 400)
  }

  if (typeof body.plan !== 'string' || !['standard', 'plus', 'pro'].includes(body.plan)) {
    return c.json({ error: 'plan 必须是 standard / plus / pro' }, 400)
  }

  return c.json({
    error: '自助升级暂不可用，请通过购买订单完成套餐变更',
    code: 'PAYMENT_REQUIRED_FOR_UPGRADE',
  }, 409)
})
