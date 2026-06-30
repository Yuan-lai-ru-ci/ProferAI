/**
 * 用户额度路由
 *
 * 计费单一真源 = New API 实扣 quota，镜像进 Profer 本地 credits 账本（quota 单位）。
 * 余额读取的是**当前用户**自己的本地 credits 余额（不再是共享池 POOL_TOTAL 减法），
 * 换算成货币单位返回（quota / NEWAPI_QUOTA_PER_UNIT），与 New API 实扣一致、可对账。
 */
import { Hono } from 'hono'
import { getRequestLogs, getUsageByModel, getCredits } from '../../db.js'
import { NEWAPI_QUOTA_PER_UNIT } from '../../config.js'

export const accountCredits = new Hono()

// GET /v1/account/credits — 当前用户本地账本余额（货币单位）
accountCredits.get('/', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ balance: null, lifetimeConsumed: 0 })
  const row = getCredits(userId)
  if (!row) return c.json({ balance: 0, lifetimeConsumed: 0 })
  // 本地账本以 quota 单位存储，÷ QUOTA_PER_UNIT 换算成货币单位展示（与 New API 一致）
  return c.json({
    balance: (row.balance || 0) / NEWAPI_QUOTA_PER_UNIT,
    lifetimeConsumed: (row.lifetime_consumed || 0) / NEWAPI_QUOTA_PER_UNIT,
  })
})

// GET /v1/account/credits/usage — 当前用户请求日志

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
