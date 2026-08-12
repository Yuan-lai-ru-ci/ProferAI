/**
 * 用户额度路由
 *
 * 计费单一真源 = New API 实扣 quota，镜像进 Profer 本地 credits 账本（quota 单位）。
 * 余额读取的是**当前用户**自己的本地 credits 余额（不再是共享池 POOL_TOTAL 减法），
 * 换算成货币单位返回（quota / NEWAPI_QUOTA_PER_UNIT），与 New API 实扣一致、可对账。
 */
import { Hono } from 'hono'
import { db, getRequestLogs, getUsageByModel, getCredits, getUserInviteCode, getSubscriptionStatus, accrueDailyDripForUser, createOrder, cancelPendingOrder, getOrder, getPayConfig, isOnlinePayReady, getConfig } from '../../db.js'
import { NEWAPI_QUOTA_PER_UNIT } from '../../config.js'
import { createPayment } from '../../payment/epay.js'

export const accountCredits = new Hono()

// GET /v1/account/credits — 当前用户余额 + 分账 + 会员信息 + 订阅状态
accountCredits.get('/', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ balance: null, lifetimeConsumed: 0 })

  // 仅累计当前用户，避免一次余额读取扫描全站 active subscriptions；累计只写待领取池。
  accrueDailyDripForUser(userId)
  const row = getCredits(userId)
  const user = db.prepare(`
    SELECT membership_tier, is_vip, multiplier,
           balance_purchased, balance_referral, balance_package
    FROM users WHERE id = ?
  `).get(userId)
  const ic = getUserInviteCode(userId)
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

// GET /v1/account/credits/recharge-config — 用户自助充值配置
// 返回档位/汇率/是否启用在线支付/微信兜底账号。供前端充值块渲染。
accountCredits.get('/recharge-config', (c) => {
  const pay = getPayConfig()
  const onlineEnabled = isOnlinePayReady()
  return c.json({
    enabled: onlineEnabled,
    manualFallback: !onlineEnabled,
    rate: pay.rate,                 // 汇率为每次充值 1 元所得积分数（默认 10：1元=10积分）
    // 档位（元）
    presetsRmb: pay.presetsRmb,
    customMinRmb: pay.customMinRmb,
    customMaxRmb: pay.customMaxRmb,
    currency: pay.currency,
    adminWechat: getConfig('misc.adminWechat') || '',
  })
})

// POST /v1/account/credits/recharge — 用户自助充值
//
// 创建充值 topup 订单（1 元 = rate 积分），若已启用在线支付则向易支付下单并返回支付信息；
// 否则降级为 manual：返回管理员微信号供用户转账，由管理员后台确认收款后到账。
//
// body: { amountRmb: number（人民币分）; payType?: 'wxpay' | 'alipay'; fromPreset?: boolean }
accountCredits.post('/recharge', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const amountRmb = Math.floor(Number(body.amountRmb))
  const payType = body.payType === 'alipay' ? 'alipay' : 'wxpay'

  const pay = getPayConfig()
  const onlineEnabled = isOnlinePayReady()

  // ---- 金额校验 ----
  if (!Number.isFinite(amountRmb) || amountRmb <= 0) {
    return c.json({ error: '充值金额无效' }, 400)
  }
  const yuan = amountRmb / 100
  if (!Number.isInteger(yuan) || yuan < pay.customMinRmb || yuan > pay.customMaxRmb) {
    return c.json({
      error: `充值金额需为整数元，且在 ${pay.customMinRmb}～${pay.customMaxRmb} 元之间`,
    }, 400)
  }

  // 积分 = 元 × rate（1元=rate积分），向下取整到整数积分
  const credits = Math.floor(yuan * pay.rate)

  try {
    // payment_method：在线支付用 'online'，人工用 'manual'（沿用现有字段）
    const order = createOrder({
      userId,
      type: 'topup',
      amountRmb,
      credits,
      remark: `用户自助充值 ¥${yuan}（${onlineEnabled ? payType : 'manual'}）`,
      createdBy: userId,
      paymentMethod: onlineEnabled ? 'online' : 'manual',
    })

    // 在线支付：向易支付下单
    if (onlineEnabled) {
      const payResult = await createPayment({
        orderId: order.id,
        amountRmb,
        payType: payType === 'alipay' ? 'alipay' : 'wxpay',
        subject: 'Profer 积分充值',
      })
      if (!payResult.success) {
        // 网关未生成支付单时，该订单不可再支付。立即取消，避免遗留 pending 脏单；
        // cancelPendingOrder 只允许 pending → cancelled，不会覆盖任何已到账状态。
        cancelPendingOrder(order.id, `易支付下单失败：${String(payResult.error || '未知错误').slice(0, 200)}`)
        console.warn('[recharge] 易支付下单失败，订单已取消', { orderId: order.id, userId, error: payResult.error })
        return c.json({
          error: payResult.error || '支付下单失败，请稍后重试',
          orderId: order.id,
          code: 'epay_submit_failed',
        }, 502)
      }
      return c.json({
        success: true,
        orderId: order.id,
        credits,
        amountRmb,
        payInfo: {
          type: payType,
          method: 'online',
          payUrl: payResult.payUrl || '',
          qrcode: payResult.qrcode || '',
        },
      })
    }

    // 人工模式：返回微信账号供转账，管理员确认后到账
    return c.json({
      success: true,
      orderId: order.id,
      credits,
      amountRmb,
      payInfo: {
        type: 'manual',
        method: 'manual',
        adminWechat: getConfig('misc.adminWechat') || '',
      },
    })
  } catch (e) {
    console.error('[recharge] 创建订单失败:', e)
    return c.json({ error: '充值订单创建失败', code: 'RECHARGE_FAILED' }, 500)
  }
})

// GET /v1/account/credits/recharge/status — 查询本人最近充值订单状态（前端轮询用）
accountCredits.get('/recharge/status', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)
  const orderId = c.req.query('orderId')
  if (!orderId) return c.json({ error: 'orderId 必填' }, 400)
  const order = getOrder(orderId)
  if (!order || order.user_id !== userId) return c.json({ error: '订单不存在' }, 404)
  return c.json({
    orderId: order.id,
    status: order.status,
    credits: order.credits,
    amountRmb: order.amount_rmb,
    type: order.type,
    paymentMethod: order.payment_method || 'manual',
  })
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
