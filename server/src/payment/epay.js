/**
 * 易支付（EPay / 彩虹易支付通用协议）对接模块
 *
 * 聚合微信/支付宝收款网关。本模块负责：
 *   - buildSign / verifySign：MD5 签名与验签
 *   - createPayment：向网关 submit.php 提交下单，返回支付二维码/跳转信息
 *
 * 配置来源：config-store（pay.epayApi / pay.epayPid / pay.epayKey / pay.notifyBase），
 * 可由 Admin 操控面板动态调整，也支持环境变量默认值。
 */
import crypto from 'crypto'
import { isOnlinePayReady, getPayConfig } from '../db/config-store.js'

/**
 * 生成签名：filter 掉空值，按 key 升序拼接 `k=v`（& 连接），末尾追加 `&key={商户密钥}`，取 MD5。
 */
export function buildSign(params, key) {
  const arr = []
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    arr.push(`${k}=${v}`)
  }
  arr.sort()
  const raw = arr.join('&') + `&key=${key}`
  return crypto.createHash('md5').update(raw, 'utf8').digest('hex')
}

/**
 * 验签：用同样的 MD5 规则比对 sign。返回 true/false。
 */
export function verifySign(params, key) {
  const sign = params.sign
  if (!sign) return false
  const { sign: _s, sign_type, ...rest } = params
  return buildSign(rest, key) === String(sign).toLowerCase()
}

/**
 * 在线支付是否已配置就绪。
 */
export function isPaymentEnabled() {
  return isOnlinePayReady()
}

/**
 * 向易支付网关创建一笔支付单。
 *
 * @param {object} opts
 * @param {string} opts.orderId     Profer 订单 id（作为 out_trade_no）
 * @param {number} opts.amountRmb   金额 RMB 分（内部统一用分，下单前换算为元）
 * @param {string} opts.payType     'wxpay' | 'alipay'
 * @param {string} opts.subject     商品名（默认「积分充值」）
 * @returns {Promise<{ success: boolean, payUrl?: string, qrcode?: string, raw?: object, error?: string }>}
 */
export async function createPayment({ orderId, amountRmb, payType, subject = '积分充值' }) {
  const pay = getPayConfig()
  if (!isOnlinePayReady()) {
    return { success: false, error: '在线支付未启用或未配置（缺失网关/商户ID/密钥/回调域名）' }
  }

  const type = payType === 'alipay' ? 'alipay' : 'wxpay'
  const money = (amountRmb / 100).toFixed(2) // 分 → 元（2 位小数）
  const notifyUrl = `${pay.notifyBase.replace(/\/+$/, '')}/v1/payment/notify`

  const params = {
    pid: pay.epayPid,
    type,
    out_trade_no: orderId,
    notify_url: notifyUrl,
    return_url: `${pay.notifyBase.replace(/\/+$/, '')}/v1/payment/return`,
    name: subject,
    money,
    sign_type: 'MD5',
  }
  params.sign = buildSign(params, pay.epayKey)

  const submitUrl = `${pay.epayApi.replace(/\/+$/, '')}/submit.php`
  try {
    const resp = await fetch(submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    const text = await resp.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* 非 JSON 响应 */ }

    // 易支付常见返回：{ code: 1, qrcode: "https://api.qrserver.com/..." , payurl: ...}
    if (data && (data.code === 1 || data.code === '1')) {
      const payUrl = data.payurl || data.url || data.qrcode || ''
      return { success: true, payUrl, qrcode: data.qrcode || '', raw: data }
    }
    // 部分网关直接返回提交表单/跳转地址
    if (!data && /^https?:\/\//i.test(text.trim())) {
      return { success: true, payUrl: text.trim(), raw: { raw: text } }
    }
    return {
      success: false,
      error: (data && (data.msg || data.message)) || `易支付下单失败（HTTP ${resp.status}）`,
      raw: data || { raw: text },
    }
  } catch (e) {
    return { success: false, error: `易支付网关请求失败: ${e.message}` }
  }
}
