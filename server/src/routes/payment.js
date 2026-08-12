/**
 * 易支付异步回调（notify）路由
 *
 * 支付完成后，易支付网关 POST 通知本接口。需验签、查单、核对金额后并把订单置为已收款，
 * 向充值积分分桶（balance_purchased）到账。本接口无需 JWT（公开回调），
 * 安全性依赖 MD5 签名 + 订单状态校验（confirmOrder 只处理 pending）+ 金额核对。
 */
import { Hono } from 'hono'
import { db, getOrder, confirmOrder, getPayConfig, isOnlinePayReady } from '../db.js'
import { verifySign } from '../payment/epay.js'

export const paymentRoutes = new Hono()

// GET /v1/payment/return — 支付完成后浏览器返回页（易支付 return_url）
paymentRoutes.get('/return', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付完成</title><style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f4f6fb;color:#172033}.card{background:#fff;border-radius:16px;padding:40px 48px;box-shadow:0 12px 32px rgba(15,23,42,.08);text-align:center}.ok{font-size:40px}.t{font-size:18px;font-weight:700;margin:12px 0 6px}.s{font-size:14px;color:#64748b}</style></head><body><div class="card"><div class="ok">✅</div><div class="t">支付处理完成</div><div class="s">请在 Profer 客户端中查看到账，充值积分会自动刷新。</div></div></body></html>
`)
})

// 幂等：confirmOrder 只对 status='pending' 生效；重复回调直接按已处理返回 success。
function idempotencyGuard(order) {
  return !!order && ['paid', 'expired'].includes(order.status)
}

// POST /v1/payment/notify — 易支付异步回调
paymentRoutes.post('/notify', async (c) => {
  try {
    const form = await c.req.parseBody().catch(() => ({}))
    const keys = Object.keys(form)
    const params = {}
    for (const k of keys) params[k] = String(form[k])

    const pay = getPayConfig()
    if (!isOnlinePayReady()) {
      return c.text('fail')
    }

    const key = pay.epayKey
    if (!verifySign(params, key)) {
      console.warn('[payment/notify] 验签失败，丢弃回调', { out_trade_no: params.out_trade_no })
      return c.text('fail')
    }

    const outTradeNo = params.out_trade_no
    const order = getOrder(outTradeNo)
    if (!order) {
      console.warn('[payment/notify] 订单不存在', { out_trade_no: outTradeNo })
      return c.text('fail')
    }

    // 幂等：已到账/已过期订单直接 success，避免重复加积分
    if (idempotencyGuard(order)) {
      return c.text('success')
    }

    if (order.status !== 'pending') {
      return c.text('fail')
    }
    if (order.type !== 'topup') {
      console.warn('[payment/notify] 非充值订单，拒绝处理', { out_trade_no: outTradeNo, type: order.type })
      return c.text('fail')
    }
    if (order.payment_method !== 'online') {
      console.warn('[payment/notify] 非在线支付订单（manual），拒绝', { out_trade_no: outTradeNo })
      return c.text('fail')
    }

    // 只有交易成功才到账
    if (String(params.trade_status) !== 'TRADE_SUCCESS') {
      // 未成功：不处理，等网关重试或前端轮询
      return c.text('success')
    }

    // 金额核对：网关返回的人民币元 → 分，与订单 amount_rmb 必须一致（容错 1 分以内）
    const paidFen = Math.round((Number(params.money) || 0) * 100)
    if (paidFen !== order.amount_rmb) {
      console.warn('[payment/notify] 金额不一致，拒绝到账', {
        out_trade_no: outTradeNo, paidFen, expectedFen: order.amount_rmb,
      })
      return c.text('fail')
    }

    // 核验：订单所有者真实存在
    const owner = db.prepare('SELECT id FROM users WHERE id = ?').get(order.user_id)
    if (!owner) {
      console.warn('[payment/notify] 订单用户不存在', { out_trade_no: outTradeNo, userId: order.user_id })
      return c.text('fail')
    }

    // 到账：confirmOrder 复用管理员确认的逻辑（topup → balance_purchased + 流水）
    try {
      confirmOrder(outTradeNo, order.user_id)
    } catch (e) {
      console.error('[payment/notify] confirmOrder 失败', e)
      // 竞争窗口内并发 confirm 或状态异常：交给网关重试
      return c.text('fail')
    }

    return c.text('success')
  } catch (e) {
    console.error('[payment/notify] 处理异常', e)
    return c.text('fail')
  }
})
