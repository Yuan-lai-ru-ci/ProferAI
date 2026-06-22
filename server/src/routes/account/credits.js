/**
 * 用户额度路由
 */
import { Hono } from 'hono'
import { getCredits, getCreditTransactions } from '../../db.js'

export const accountCredits = new Hono()

// GET /v1/account/credits — 当前用户余额
accountCredits.get('/', (c) => {
  const userId = c.get('userId')
  const credits = getCredits(userId)
  return c.json({
    balance: credits?.balance || 0,
    lifetimeConsumed: credits?.lifetime_consumed || 0,
  })
})

// GET /v1/account/credits/transactions — 当前用户交易记录
accountCredits.get('/transactions', (c) => {
  const userId = c.get('userId')
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)
  const type = c.req.query('type') || undefined
  const result = getCreditTransactions({ userId, type, page, limit })
  return c.json(result)
})
