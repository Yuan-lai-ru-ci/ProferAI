import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'x'.repeat(64)
process.env.DB_PATH = ':memory:'

let dbModule
let middleware
let adminMiddleware
let tierGateMiddleware

beforeAll(async () => {
  dbModule = await import('../db.js')
  middleware = await import('../middleware.js')
  ;({ adminMiddleware } = await import('./admin.js'))
  ;({ tierGateMiddleware } = await import('./tier-gate.js'))
})

function insertUser(id, { isAdmin = 0, suspended = 0, tier = 'free' } = {}) {
  dbModule.db.prepare(`INSERT OR REPLACE INTO users
    (id, email, password_hash, display_name, is_admin, is_suspended, membership_tier, created_at)
    VALUES (?, ?, 'hash', ?, ?, ?, ?, ?)`)
    .run(id, `${id}@example.com`, id, isAdmin, suspended, tier, Date.now())
}

function tokenFor(id, claims = {}) {
  return jwt.sign({ sub: id, email: 'stale@example.com', is_admin: true, membership_tier: 'pro', ...claims }, 'x'.repeat(64), { expiresIn: '1h' })
}

function protectedApp() {
  const app = new Hono()
  app.use('*', middleware.honoAuthMiddleware)
  app.get('/me', (c) => c.json({ userId: c.get('userId'), payload: c.get('jwtPayload') }))
  return app
}

describe('实时 JWT 授权上下文', () => {
  test('Given JWT 声称管理员 Pro When DB 已撤权降级 Then context 使用 DB 当前状态', async () => {
    insertUser('auth-demoted', { isAdmin: 0, tier: 'free' })
    const res = await protectedApp().request('/me', { headers: { Authorization: `Bearer ${tokenFor('auth-demoted')}` } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.payload).toMatchObject({ sub: 'auth-demoted', is_admin: false, membership_tier: 'free' })
    expect(body.payload.email).toBe('auth-demoted@example.com')
  })

  test('Given 有效 JWT When 用户已停用或删除 Then 拒绝而不进入下游', async () => {
    insertUser('auth-suspended', { suspended: 1 })
    const suspended = await protectedApp().request('/me', { headers: { Authorization: `Bearer ${tokenFor('auth-suspended')}` } })
    expect(suspended.status).toBe(403)
    expect((await suspended.json()).code).toBe('ACCOUNT_SUSPENDED')

    const missing = await protectedApp().request('/me', { headers: { Authorization: `Bearer ${tokenFor('auth-missing')}` } })
    expect(missing.status).toBe(401)
    expect((await missing.json()).code).toBe('ACCOUNT_NOT_FOUND')
  })

  test('Given DB 已撤销管理员 When 使用旧管理员 JWT 调用 Admin Then 返回 403', async () => {
    insertUser('auth-admin', { isAdmin: 0 })
    const app = new Hono()
    app.use('*', middleware.honoAuthMiddleware)
    app.use('*', adminMiddleware)
    app.get('/admin', c => c.json({ ok: true }))
    const res = await app.request('/admin', { headers: { Authorization: `Bearer ${tokenFor('auth-admin')}` } })
    expect(res.status).toBe(403)
  })

  test('Given DB 将 Pro 降级为 Free When 旧 Pro JWT 请求国际模型 Then tier gate 拒绝', async () => {
    insertUser('auth-tier', { tier: 'free' })
    const app = new Hono()
    app.use('*', middleware.honoAuthMiddleware)
    app.use('*', tierGateMiddleware)
    app.post('/proxy', c => c.json({ ok: true }))
    const res = await app.request('/proxy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor('auth-tier')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('tier_restricted')
  })

  test('Given API key 关联用户被停用 When 请求 proxy Then 使用实时用户状态拒绝', async () => {
    insertUser('auth-key-suspended')
    const { plaintext } = dbModule.createApiKey({ userId: 'auth-key-suspended', name: 'test' })
    dbModule.db.prepare('UPDATE users SET is_suspended = 1 WHERE id = ?').run('auth-key-suspended')
    const app = new Hono()
    app.use('*', middleware.proxyAuthMiddleware)
    app.get('/proxy', c => c.json({ ok: true }))
    const res = await app.request('/proxy', { headers: { Authorization: `Bearer ${plaintext}` } })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('ACCOUNT_SUSPENDED')
  })
})
