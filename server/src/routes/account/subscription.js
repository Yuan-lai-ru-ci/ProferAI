/**
 * 套餐订阅路由 — 订阅状态、升级、销毁、drip 领取
 */
import { Hono } from 'hono'
import {
  getSubscriptionStatus,
  destroySubscription,
  upgradeSubscription,
  claimDrip,
  accrueDailyDrip,
} from '../../db.js'

export const accountSubscription = new Hono()

// GET /v1/account/subscription — 当前订阅状态
// 鉴权由 accountApp.use('*', honoAuthMiddleware) 统一处理
accountSubscription.get('/', (c) => {
  const userId = c.get('userId')
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

  // 先累加今日 drip（幂等，同日不重复）
  accrueDailyDrip()

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

// POST /v1/account/subscription/upgrade — 升级套餐
accountSubscription.post('/upgrade', async (c) => {
  const userId = c.get('userId')
  const { plan } = await c.req.json()
  if (!plan || !['standard', 'plus', 'pro'].includes(plan)) {
    return c.json({ error: 'plan 必须是 standard / plus / pro' }, 400)
  }

  try {
    upgradeSubscription(userId, plan)
  } catch (e) {
    if (e.message === 'NO_ACTIVE_SUBSCRIPTION') {
      return c.json({ error: '没有活跃的订阅，请先购买套餐' }, 400)
    }
    if (e.message === 'INVALID_PLAN') {
      return c.json({ error: '无效的套餐等级' }, 400)
    }
    throw e
  }

  return c.json({ success: true, plan })
})
