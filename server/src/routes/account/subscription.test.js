/**
 * 订阅自助入口安全回归测试。
 *
 * upgrade 不得绕过支付直接变更套餐权益。
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mock } from 'bun:test'
import { installBunSqliteMock } from '../../test-helpers/sqlite-bun-adapter.js'

installBunSqliteMock(mock)

// subscription.js 经 db.js 间接加载 config；必须在动态导入前设置安全测试配置。
process.env.JWT_SECRET = 'x'.repeat(64)

let app

beforeAll(async () => {
  // 路由本身不访问数据库；用测试中间件注入已认证用户，隔离 JWT/SQLite 基础设施。
  const { accountSubscription } = await import('./subscription.js')
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId', 'test-user')
    await next()
  })
  app.route('/subscription', accountSubscription)
})

describe('subscription upgrade payment boundary', () => {
  test('Given authenticated user When requesting upgrade Then returns 409 and never grants entitlement directly', async () => {
    const response = await app.request('/subscription/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'PAYMENT_REQUIRED_FOR_UPGRADE',
    })
  })

  test('Given malformed plan When requesting upgrade Then rejects before any entitlement mutation', async () => {
    const response = await app.request('/subscription/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'enterprise' }),
    })

    expect(response.status).toBe(400)
  })
})
