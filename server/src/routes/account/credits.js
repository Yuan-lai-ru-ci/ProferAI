/**
 * 用户额度路由
 *
 * 计费单一真源 = New API 实扣 quota，镜像进 Profer 本地 credits 账本（quota 单位）。
 * 余额读取的是**当前用户**自己的本地 credits 余额（不再是共享池 POOL_TOTAL 减法），
 * 换算成货币单位返回（quota / NEWAPI_QUOTA_PER_UNIT），与 New API 实扣一致、可对账。
 */
import { Hono } from 'hono'
import { db, getRequestLogs, getUsageByModel, getCredits, getUserInviteCode, getSubscriptionStatus, accrueDailyDrip } from '../../db.js'
import { NEWAPI_QUOTA_PER_UNIT } from '../../config.js'

export const accountCredits = new Hono()

// GET /v1/account/credits — 当前用户余额 + 分账 + 会员信息 + 订阅状态
accountCredits.get('/', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ balance: null, lifetimeConsumed: 0 })

  const row = getCredits(userId)
  const user = db.prepare(`
    SELECT membership_tier, is_vip, multiplier,
           balance_purchased, balance_referral, balance_package
    FROM users WHERE id = ?
  `).get(userId)
  const ic = getUserInviteCode(userId)
  // 先累加今日 drip（幂等，同日不重复），确保前端显示的 dripAvailableThisWeek 是当天最新值
  accrueDailyDrip()
  const sub = getSubscriptionStatus(userId)

  const qpu = NEWAPI_QUOTA_PER_UNIT
  return c.json({
    // 旧字段兼容
    balance: (row?.balance || 0) / qpu,
    lifetimeConsumed: (row?.lifetime_consumed || 0) / qpu,
    // 积分分账
    balancePackage: (user?.balance_package || 0) / qpu,
    balanceReferral: (user?.balance_referral || 0) / qpu,
    balancePurchased: (user?.balance_purchased || 0) / qpu,
    // 会员
    membershipTier: user?.membership_tier || 'free',
    isVip: !!user?.is_vip,
    multiplier: user?.multiplier || 1.0,
    inviteCode: ic?.code || '',
    // 订阅
    subscription: sub || null,
  })
})

// POST /v1/account/credits/recharge — 用户自助充值（预留）
//
// 当前未接入支付，返回 501 + 引导联系管理员。接支付时在此：
//   1. 校验金额/创建 payment_orders 订单
//   2. 跳转支付服务商 hosted checkout（带订单号/用户id 元数据）
//   3. 支付回调 webhook 验签后调 grantCredits(userId, usd*NEWAPI_QUOTA_PER_UNIT) 加额度
// 管理员手动充值走 admin-ui「手动充值」（已支持，按美元）。
accountCredits.post('/recharge', (c) => {
  return c.json({
    error: '自助充值暂未开放，请联系管理员充值',
    code: 'recharge_not_configured',
  }, 501)
})

// GET /v1/account/credits/usage — 当前用户请求日志
accountCredits.get('/usage', (c) => {
  const userId = c.get('userId')
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)
  const result = getRequestLogs({ userId, page, limit })
  return c.json(result)
})

// GET /v1/account/credits/usage-by-model — 当前用户按模型用量统计
accountCredits.get('/usage-by-model', (c) => {
  const userId = c.get('userId')
  const days = parseInt(c.req.query('days') || '30', 10)
  const result = getUsageByModel({ userId, days })
  return c.json(result)
})
