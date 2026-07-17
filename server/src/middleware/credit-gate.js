/**
 * 余额门禁中间件 — 请求转发前检查用户三桶余额总和，防止透支超限。
 *
 * 三桶总和（balance_package + balance_referral + balance_purchased）允许
 * 最低透支 2,500,000 quota（-50 积分），超出此限才拒绝。
 * 实际扣费由 proxy/chat.js 的 reconcileAndBill 事后对账完成。
 */
import { db } from '../db.js'
import { NEWAPI_QUOTA_PER_UNIT } from '../config.js'

/** 透支上限：-50 积分 = -2,500,000 quota */
const OVERDRAFT_LIMIT = 2_500_000

/** quota → 积分（保留 3 位小数，最小 0.001） */
function quotaToPoints(q) {
  return Math.max(0.001, Math.round((q / NEWAPI_QUOTA_PER_UNIT) * 10000) / 1000)
}

export async function creditGateMiddleware(c, next) {
  const payload = c.get('jwtPayload')
  if (!payload?.sub) return next()

  try {
    const user = db.prepare(
      'SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?'
    ).get(payload.sub)

    const total = (user?.balance_package || 0) + (user?.balance_referral || 0) + (user?.balance_purchased || 0)

    if (total < -OVERDRAFT_LIMIT) {
      return c.json({
        error: '额度不足',
        message: `已超出透支上限（-50 积分），当前总额 ${quotaToPoints(total)} 积分，请充值后重试`,
        balance: total,
        overdraftLimit: -OVERDRAFT_LIMIT,
      }, 402)
    }
  } catch (err) {
    // DB 查询失败不阻塞请求（宁可放行也不能误杀），记告警
    console.warn('[credit-gate] 余额查询失败:', err.message)
  }

  await next()
}
