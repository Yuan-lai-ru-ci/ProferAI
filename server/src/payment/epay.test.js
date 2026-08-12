/**
 * 易支付模块单测（签名逻辑 + 支付配置就绪判断）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { installBunSqliteMock } from '../test-helpers/sqlite-bun-adapter.js'

installBunSqliteMock(mock)

let tempDir
let dbModule // server/src/db.js
let epay
let accountCredits
let paymentRoutes
let originalFetch

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'profer-epay-'))
  process.env.JWT_SECRET = 'x'.repeat(64)
  process.env.DB_PATH = join(tempDir, 'test.db')
  process.env.DATA_DIR = tempDir
  dbModule = await import('../db.js')
  epay = await import('./epay.js')
  ;({ accountCredits } = await import('../routes/account/credits.js'))
  ;({ paymentRoutes } = await import('../routes/payment.js'))
  originalFetch = globalThis.fetch
})

afterAll(() => {
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

beforeEach(() => {
  // 按用例独立配置，避免用例间互相污染
  dbModule.resetConfig('pay.onRecharge')
  dbModule.resetConfig('pay.epayApi')
  dbModule.resetConfig('pay.epayPid')
  dbModule.resetConfig('pay.epayKey')
  dbModule.resetConfig('pay.notifyBase')
  globalThis.fetch = originalFetch
})

function makeUser(id) {
  dbModule.db.prepare('INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${id}@example.com`, 'hash', id, Date.now())
  dbModule.ensureCreditRow(id)
  dbModule.db.prepare('UPDATE users SET balance_package = 0, balance_referral = 0, balance_purchased = 0 WHERE id = ?').run(id)
}

function accountAppFor(userId) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  app.route('/credits', accountCredits)
  return app
}

function enableOnlinePay() {
  dbModule.setConfigs({
    'pay.onRecharge': 1,
    'pay.epayApi': 'https://epay.example.com',
    'pay.epayPid': '1001',
    'pay.epayKey': 'SECRETKEY',
    'pay.notifyBase': 'https://profer.example.com',
  })
}

describe('易支付签名', () => {
  test('buildSign 按 key 升序拼接并附加商户密钥', () => {
    const params = { pid: '1001', type: 'alipay', out_trade_no: 'ORDER_ABC', name: '积分充值', money: '10.00' }
    const key = 'merchant_key'
    const sign = epay.buildSign(params, key)
    const expected = crypto.createHash('md5')
      .update('money=10.00&name=积分充值&out_trade_no=ORDER_ABC&pid=1001&type=alipay&key=merchant_key', 'utf8')
      .digest('hex')
    expect(sign).toBe(expected)
  })

  test('verifySign 正确通过 / 篡改失败 / 缺 sign 失败', () => {
    const key = 'k'
    const body = { pid: '1', money: '5.00', out_trade_no: 'O1', trade_status: 'TRADE_SUCCESS' }
    const sign = epay.buildSign(body, key)
    expect(epay.verifySign({ ...body, sign, sign_type: 'MD5' }, key)).toBe(true)

    const tampered = { ...body, money: '500.00', sign, sign_type: 'MD5' }
    expect(epay.verifySign(tampered, key)).toBe(false)

    expect(epay.verifySign({ money: '5.00' }, key)).toBe(false)
  })

  test('空值字段不参与签名', () => {
    const key = 'k'
    const body = { pid: '1', extra: '', money: '5.00' }
    const sign = epay.buildSign(body, key)
    expect(epay.verifySign({ ...body, extra: '', sign, sign_type: 'MD5' }, key)).toBe(true)
  })
})

describe('在线支付就绪判断', () => {
  test('未配置时 isPaymentEnabled 为 false', () => {
    expect(epay.isPaymentEnabled()).toBe(false)
  })

  test('配置完整后 isPaymentEnabled 为 true', () => {
    enableOnlinePay()
    expect(epay.isPaymentEnabled()).toBe(true)
  })

  test('缺回调域名时 isPaymentEnabled 为 false', () => {
    dbModule.setConfigs({
      'pay.onRecharge': 1,
      'pay.epayApi': 'https://epay.example.com',
      'pay.epayPid': '1001',
      'pay.epayKey': 'SECRETKEY',
      // 无 notifyBase
    })
    expect(epay.isPaymentEnabled()).toBe(false)
  })

  test('createPayment 未就绪时返回失败并附错误', async () => {
    const r = await epay.createPayment({ orderId: 'O1', amountRmb: 1000, payType: 'wxpay' })
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('充值下单与支付回调闭环', () => {
  test('拒绝未认证、非整数元和越界充值金额', async () => {
    const unauthenticated = new Hono()
    unauthenticated.route('/credits', accountCredits)
    expect((await unauthenticated.request('/credits/recharge', { method: 'POST', body: '{}' })).status).toBe(401)

    const userId = 'recharge-invalid-input'
    makeUser(userId)
    const app = accountAppFor(userId)
    for (const amountRmb of [99, 0, 100_100]) {
      const response = await app.request('/credits/recharge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountRmb }),
      })
      expect(response.status).toBe(400)
    }
  })

  test('网关下单失败时取消订单，用户重试不会遗留 pending 脏单', async () => {
    const userId = 'recharge-submit-failed'
    makeUser(userId)
    enableOnlinePay()
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, msg: '网关维护中' }), { status: 200 })

    const response = await accountAppFor(userId).request('/credits/recharge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountRmb: 1000, payType: 'wxpay' }),
    })
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.code).toBe('epay_submit_failed')
    expect(dbModule.getOrder(body.orderId).status).toBe('cancelled')
  })

  test('正确回调仅为本人充值一次，重复回调幂等，篡改金额被拒绝', async () => {
    const userId = 'recharge-paid-user'
    const otherUserId = 'recharge-other-user'
    makeUser(userId)
    makeUser(otherUserId)
    enableOnlinePay()
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, payurl: 'https://epay.example.com/pay/1' }), { status: 200 })

    const accountApp = accountAppFor(userId)
    const create = await accountApp.request('/credits/recharge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountRmb: 1000, payType: 'alipay' }),
    })
    expect(create.status).toBe(200)
    const created = await create.json()
    expect(created.payInfo.method).toBe('online')

    const callback = { out_trade_no: created.orderId, money: '10.00', trade_status: 'TRADE_SUCCESS' }
    const sign = epay.buildSign(callback, 'SECRETKEY')
    const request = () => paymentRoutes.request('/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...callback, sign, sign_type: 'MD5' }).toString(),
    })
    expect(await (await request()).text()).toBe('success')
    expect(await (await request()).text()).toBe('success')
    expect(dbModule.getOrder(created.orderId).status).toBe('paid')
    expect(dbModule.getCredits(userId).balance).toBe(5_000_000)
    expect(dbModule.db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE reference_type = 'order' AND reference_id = ?").get(created.orderId).count).toBe(1)

    const ownStatus = await accountApp.request(`/credits/recharge/status?orderId=${created.orderId}`)
    expect(ownStatus.status).toBe(200)
    expect((await accountAppFor(otherUserId).request(`/credits/recharge/status?orderId=${created.orderId}`)).status).toBe(404)

    const second = dbModule.createOrder({ userId, type: 'topup', amountRmb: 1000, credits: 10, paymentMethod: 'online' })
    const tampered = { out_trade_no: second.id, money: '100.00', trade_status: 'TRADE_SUCCESS' }
    const tamperedSign = epay.buildSign(tampered, 'SECRETKEY')
    const tamperedResponse = await paymentRoutes.request('/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...tampered, sign: tamperedSign, sign_type: 'MD5' }).toString(),
    })
    expect(await tamperedResponse.text()).toBe('fail')
    expect(dbModule.getOrder(second.id).status).toBe('pending')
  })
})
