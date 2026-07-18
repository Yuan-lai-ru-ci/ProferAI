/**
 * 余额门禁中间件 — 请求转发前检查用户三桶余额总和，防止透支超限。
 *
 * 三桶总和（balance_package + balance_referral + balance_purchased）允许
 * 最低透支 2,500,000 quota（-50 积分），超出此限才拒绝。
 * 实际扣费由 proxy/chat.js 的 reconcileAndBill 事后对账完成。
 *
 * DB 容错策略：
 *   正常 → DB 查询失败放行（可用性优先）
 *   连续失败 ≥5 次（60s 内）→ 切换为拒绝模式（计费安全优先）
 *   恢复后自动切回放行模式
 */
import { db, getBillingConfig } from '../db.js'
import { NEWAPI_QUOTA_PER_UNIT } from '../config.js'

/** 连续失败阈值：达到后切换为拒绝模式 */
const FAIL_THRESHOLD = 5
/** 失败窗口（ms）：在此时间窗内的连续失败才累计 */
const FAIL_WINDOW_MS = 15_000  // 缩短到 15 秒，防止 DB 短暂故障时大量免费放行

let _consecutiveFails = 0
let _firstFailTime = 0
let _denyMode = false

/** quota → 积分（保留 3 位小数，最小 0.001） */
function quotaToPoints(q) {
  return Math.max(0.001, Math.round((q / NEWAPI_QUOTA_PER_UNIT) * 10000) / 1000)
}

/** 门禁与正常扣款共用的透支边界：恰好到达下限仍允许。 */
export function exceedsOverdraftLimit(total, overdraftLimit) {
  return total < -overdraftLimit
}

export async function creditGateMiddleware(c, next) {
  const payload = c.get('jwtPayload')
  if (!payload?.sub) return next()

  // 拒绝模式：DB 持续故障，不允许透支
  if (_denyMode) {
    // 试探性查询一次，看恢复了没
    let recovered = false
    try {
      db.prepare('SELECT 1').get()
      recovered = true
    } catch { /* 仍然故障 */ }

    if (recovered) {
      _denyMode = false
      _consecutiveFails = 0
      _firstFailTime = 0
      console.log('[credit-gate] DB 已恢复，退出拒绝模式')
      // 恢复后继续走正常流程（下面会再查一次余额）
    } else {
      return c.json({
        error: '服务暂时不可用',
        message: '计费服务异常，请稍后重试',
      }, 503)
    }
  }

  try {
    const user = db.prepare(
      'SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?'
    ).get(payload.sub)

    // 查询成功：重置计数
    if (_consecutiveFails > 0) {
      _consecutiveFails = 0
      _firstFailTime = 0
    }

    const total = (user?.balance_package || 0) + (user?.balance_referral || 0) + (user?.balance_purchased || 0)

    const { overdraftLimit } = getBillingConfig()
    if (exceedsOverdraftLimit(total, overdraftLimit)) {
      return c.json({
        error: '额度不足',
        message: `已超出透支上限（${quotaToPoints(-overdraftLimit)} 积分），当前总额 ${quotaToPoints(total)} 积分，请充值后重试`,
        balance: total,
        overdraftLimit: -overdraftLimit,
      }, 402)
    }
  } catch (err) {
    const now = Date.now()

    // 重置窗口：距离上次首次失败超过 FAIL_WINDOW_MS
    if (now - _firstFailTime > FAIL_WINDOW_MS) {
      _consecutiveFails = 0
      _firstFailTime = now
    }
    if (_firstFailTime === 0) _firstFailTime = now

    _consecutiveFails++

    if (_consecutiveFails >= FAIL_THRESHOLD) {
      _denyMode = true
      console.error(`[credit-gate] 🚨 DB 连续失败 ${_consecutiveFails} 次（${FAIL_WINDOW_MS}ms 内），切换为拒绝模式（保护计费安全）`)
      console.error(`[credit-gate] 🚨 错误详情: ${err.message}`)
      // TODO: 发送告警到运维通知渠道（webhook/邮件/飞书）
      return c.json({
        error: '服务暂时不可用',
        message: '计费服务异常，请稍后重试',
      }, 503)
    }

    // 未达阈值：放行，记告警
    console.warn(`[credit-gate] 余额查询失败 (${_consecutiveFails}/${FAIL_THRESHOLD}): ${err.message}`)
  }

  await next()
}
