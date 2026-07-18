/**
 * Public 路由 — 无需登录态，供官网等公开页面调用
 */
import { Hono } from 'hono'
import { getPlanDefs, getVipConfig } from '../../db/config-store.js'
import { strictRateLimit } from '../../middleware/rate-limit.js'

export const publicRoutes = new Hono()

// GET /v1/public/plans — 返回套餐定价（公开，无鉴权，限速 10 次/分钟）
publicRoutes.get('/plans', strictRateLimit, (c) => {
  const plans = getPlanDefs()
  const vip = getVipConfig()

  // 只返回用户可见的定价信息，隐藏内部运营参数
  return c.json({
    plans: {
      free: {
        name: 'Free',
        monthlyRmb: 0,
        yearlyRmb: 0,
      },
      standard: {
        name: 'Standard',
        monthlyRmb: plans.standard.monthlyRmb,
        yearlyRmb: plans.standard.yearlyRmb,
      },
      plus: {
        name: 'Plus',
        monthlyRmb: plans.plus.monthlyRmb,
        yearlyRmb: plans.plus.yearlyRmb,
      },
      pro: {
        name: 'Pro',
        monthlyRmb: plans.pro.monthlyRmb,
        yearlyRmb: plans.pro.yearlyRmb,
      },
    },
    vip: {
      price: vip.price,
      discount: vip.discount,
    },
  })
})
