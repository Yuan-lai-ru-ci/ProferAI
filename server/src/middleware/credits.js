/**
 * 额度检查中间件 — 在商业模式下扣减额度
 *
 * 需要在 authMiddleware 之后、proxy handler 之前挂载
 */
import { COMMERCIAL_MODE } from '../config.js'
import { deductCredits, getCredits } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

/** 简单成本估算：按模型每 1K token 的价格，返回整数 credits（1 credit ≈ $0.00001 USD） */
function estimateCost(c) {
  try {
    const body = c.get('proxyBody') || {}
    const model = body.model || ''
    const maxTokens = body.max_tokens || 4096

    // 各模型每 1K 输出 token 的大致价格（credits）
    const pricing = {
      'deepseek-v4-pro': 2,
      'deepseek-v4-flash': 1,
      'claude-sonnet-4-5': 15,
      'claude-haiku-4-5': 3,
      'gpt-5': 15,
      'gpt-5-mini': 2,
      'kimi-k2': 3,
    }

    let rate = 3 // 默认
    for (const [key, r] of Object.entries(pricing)) {
      if (model.includes(key)) { rate = r; break }
    }

    return Math.max(1, Math.ceil((maxTokens / 1000) * rate))
  } catch {
    return 5 // 默认估算 5 credits
  }
}

export async function creditCheckMiddleware(c, next) {
  if (!COMMERCIAL_MODE) return next()

  const payload = c.get('jwtPayload')
  if (!payload?.sub) return next()

  // 读取请求体用于估算
  let body = {}
  try {
    body = await c.req.json()
    c.set('proxyBody', body)
  } catch { /* body 可能已被读取 */ }

  const estimated = estimateCost({ ...c, body })
  try {
    deductCredits(payload.sub, estimated, {
      description: `估算: ${estimated} credits`,
      referenceType: 'api_call',
      referenceId: uuidv4(),
    })
    c.set('creditDeducted', estimated)
  } catch (err) {
    if (err.message?.startsWith('INSUFFICIENT_CREDITS')) {
      const balance = err.message.split(':')[1] || '0'
      return c.json({
        error: '额度不足',
        message: `当前余额 ${balance} credits，本次预估消耗 ${estimated} credits`,
        balance: parseInt(balance, 10),
        required: estimated,
      }, 402)
    }
    throw err
  }

  await next()
}
