/**
 * 额度检查中间件 — 在商业模式下扣减额度
 *
 * 需要在 authMiddleware 之后、proxy handler 之前挂载
 */
import { COMMERCIAL_MODE } from '../config.js'
import { deductCredits } from '../db.js'
import { estimateProxyCost } from '../billing-utils.js'
import { getPricingCached } from '../shared/pricing-cache.js'
import { v4 as uuidv4 } from 'uuid'

export async function creditCheckMiddleware(c, next) {
  if (!COMMERCIAL_MODE) return next()

  const payload = c.get('jwtPayload')
  if (!payload?.sub) return next()

  // 读取请求体用于估算（clone 避免消费原始流，确保后续 handler 仍可读取）
  let body = {}
  try {
    body = await c.req.raw.clone().json()
    c.set('proxyBody', body)
  } catch {
    return c.json({ error: '请求体必须是 JSON' }, 400)
  }

  const estimated = estimateProxyCost(body, getPricingCached())
  const requestId = uuidv4()
  try {
    const txId = deductCredits(payload.sub, estimated, {
      description: `估算: ${estimated} credits`,
      referenceType: 'api_call',
      referenceId: requestId,
    })
    c.set('proxyRequestId', requestId)
    c.set('creditDeducted', estimated)
    c.set('creditTxId', txId)
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
