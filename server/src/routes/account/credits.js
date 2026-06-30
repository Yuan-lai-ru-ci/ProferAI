/**
 * 用户额度路由
 *
 * 计费已收敛到 New API：余额读取的是「共享额度池」(RELAY_API_KEY 对应的 New API
 * 账号)的真实消耗，通过 /v1/dashboard/billing/usage 获取（该接口 token key 可调）。
 * 所有 Profer 用户共用这一个池。
 */
import { Hono } from 'hono'
import { getRequestLogs, getUsageByModel } from '../../db.js'
import { RELAY_BASE_URL, RELAY_API_KEY } from '../../config.js'

export const accountCredits = new Hono()

// 共享池总额度（可配环境变量手动设；未配时用 New API users.quota 推算值）
const POOL_TOTAL = parseInt(process.env.POOL_TOTAL_QUOTA || '0', 10) || undefined

// 缓存
let _balanceCache = { value: null, at: 0 }
const BALANCE_TTL = 30_000

/** 调 New API /v1/dashboard/billing/usage 拿累计消耗(美分)；失败返回 null。 */
async function fetchPoolUsage() {
  const now = Date.now()
  if (_balanceCache.value && now - _balanceCache.at < BALANCE_TTL) {
    return _balanceCache.value
  }
  if (!RELAY_API_KEY) return null
  try {
    const resp = await fetch(`${RELAY_BASE_URL}/v1/dashboard/billing/usage`, {
      headers: { Authorization: `Bearer ${RELAY_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return _balanceCache.value
    const json = await resp.json()
    // total_usage 单位美分 → 美元
    const consumed = Math.round((json.total_usage || 0)) / 100
    // 余额 = 总额度 - 累计消耗（总额度未配时只显示消耗）
    const total = POOL_TOTAL ? POOL_TOTAL / 500000 : undefined
    const result = {
      lifetimeConsumed: consumed,
      balance: total != null ? Math.max(0, total - consumed) : null,
      total: total,
      shared: true,
    }
    _balanceCache = { value: result, at: now }
    return result
  } catch {
    return _balanceCache.value
  }
}

// GET /v1/account/credits — 共享额度池余额
accountCredits.get('/', async (c) => {
  const pool = await fetchPoolUsage()
  if (!pool) {
    return c.json({ balance: null, lifetimeConsumed: 0, shared: true })
  }
  return c.json({
    balance: pool.balance,
    lifetimeConsumed: pool.lifetimeConsumed,
    shared: true,
  })
})

// GET /v1/account/credits/usage — 当前用户请求日志（token 用量，不计费）
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
