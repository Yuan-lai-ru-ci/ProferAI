/**
 * Account 配置路由 — 客户端可读的套餐定价等信息
 *
 * 无需 admin 权限。供 SubscriptionSettings 等前端页面调用。
 */
import { Hono } from 'hono'
import { getPlanDefs, getPlanDefsRedeem, getVipConfig, getConfig } from '../../db/config-store.js'

export const accountConfig = new Hono()

// GET /v1/account/config/plans — 返回套餐定价 + VIP 信息
accountConfig.get('/plans', (c) => {
  const plans = getPlanDefs()
  const vip = getVipConfig()
  const adminWechat = getConfig('misc.adminWechat')

  return c.json({
    plans: {
      free: {
        id: 'free',
        name: 'Free',
        monthlyRmb: 0,
        yearlyRmb: 0,
        welcomeBonus: 0,
        dailyDrip: 0,
      },
      standard: {
        id: 'standard',
        name: 'Standard',
        ...plans.standard,
      },
      plus: {
        id: 'plus',
        name: 'Plus',
        ...plans.plus,
      },
      pro: {
        id: 'pro',
        name: 'Pro',
        ...plans.pro,
      },
    },
    vip: {
      price: vip.price,       // 人民币分
      discount: vip.discount,
      extraDrip: vip.extraDrip,
    },
    adminWechat,
  })
})
