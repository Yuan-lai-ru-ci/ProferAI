/**
 * 账户/鉴权安全链路 — node 原生测试（独立进程，避免 bun 全量跑时模块缓存污染）。
 *
 * 场景：COMMERCIAL_MODE=true + PER_USER_NEWAPI_KEY=false
 *  - 注册成功：三令牌 + refresh 30 天过期
 *  - refresh 轮换 + 滑动续期
 *  - refresh 过期 → 401 refresh_token_expired
 *  - 撤销设备 → relay token 立即轮换（旧 prelay_ 失效）
 *  - 登录 revokeSlotId → 同样触发 relay 轮换
 */
process.env.JWT_SECRET = 'x'.repeat(64)
process.env.DB_PATH = ':memory:'
process.env.COMMERCIAL_MODE = 'true'
process.env.PER_USER_NEWAPI_KEY = 'false' // 注册走异步建号路径，不阻塞；relay 逻辑与 New API 无关
process.env.CHANNEL_ENCRYPTION_KEY = 'y'.repeat(64)
process.env.RELAY_API_KEY = 'test-relay-key'
process.env.RELAY_BASE_URL = 'http://127.0.0.1:9' // 不可达；异步建号失败仅 warn，不阻塞

import test from 'node:test'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const dbModule = await import('../db.js')
const { authRoutes } = await import('./auth.js')
const db = dbModule.db

const TTL_30D = 30 * 86400 * 1000

function seedActivationCode(code = `TEST-ACT-${uuidv4().slice(0, 8)}`) {
  db.prepare(
    `INSERT INTO activation_codes (id, code, status, created_at) VALUES (?, ?, 'pending', ?)`
  ).run(uuidv4(), code, Date.now())
  return code
}

async function registerUser(email, { deviceId = `dev-${email}` } = {}) {
  const code = seedActivationCode()
  const res = await authRoutes.request('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Passw0rd123',
      displayName: email.split('@')[0],
      activationCode: code,
      deviceId,
      deviceName: 'Test Machine',
      platform: 'win32',
      appVersion: '0.0.0-test',
    }),
  })
  return { status: res.status, body: await res.json() }
}

async function loginUser(email, { deviceId = `dev-${email}`, revokeSlotId } = {}) {
  const res = await authRoutes.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Passw0rd123',
      deviceId,
      deviceName: 'Test Machine',
      platform: 'win32',
      appVersion: '0.0.0-test',
      ...(revokeSlotId ? { revokeSlotId } : {}),
    }),
  })
  return { status: res.status, body: await res.json() }
}

async function refreshToken(refreshToken, deviceId) {
  const res = await authRoutes.request('/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, deviceId }),
  })
  return { status: res.status, body: await res.json() }
}

test('注册成功：签发三令牌，refresh 带 30 天过期', async () => {
  const email = 'auth-node-1@example.com'
  const { status, body } = await registerUser(email)
  assert.equal(status, 200)
  assert.ok(body.accessToken)
  assert.ok(body.refreshToken)
  assert.match(body.relayToken, /^prelay_/)

  const row = db.prepare('SELECT expires_at FROM refresh_tokens WHERE user_id = ?').get(body.teamAccountId)
  assert.ok(row)
  assert.ok(row.expires_at > Date.now() + TTL_30D - 60_000)
  assert.ok(row.expires_at <= Date.now() + TTL_30D)
})

test('刷新成功：refreshToken 轮换且过期时间滑动续期', async () => {
  const email = 'auth-node-2@example.com'
  const reg = await registerUser(email)

  // 模拟接近 TTL 边界（尚未过期），刷新应滑动回 30 天
  db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?')
    .run(Date.now() + 60_000, reg.body.teamAccountId)

  const res = await refreshToken(reg.body.refreshToken, `dev-${email}`)
  assert.equal(res.status, 200)
  assert.notEqual(res.body.refreshToken, reg.body.refreshToken) // 轮换

  const after = db.prepare('SELECT expires_at FROM refresh_tokens WHERE user_id = ?').get(reg.body.teamAccountId)
  assert.ok(after.expires_at > Date.now() + TTL_30D - 60_000) // 滑动回 30 天
})

test('refresh token 过期：返回 401 refresh_token_expired 且槽位被清理', async () => {
  const email = 'auth-node-3@example.com'
  const reg = await registerUser(email)

  db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?')
    .run(Date.now() - 1000, reg.body.teamAccountId)

  const res = await refreshToken(reg.body.refreshToken, `dev-${email}`)
  assert.equal(res.status, 401)
  assert.equal(res.body.code, 'refresh_token_expired')

  const remain = db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ?').get(reg.body.teamAccountId)
  assert.equal(remain.c, 0)
})

test('撤销设备：refresh 槽位删除且 relay token 立即轮换', async () => {
  const email = 'auth-node-4@example.com'
  const reg = await registerUser(email, { deviceId: 'dev-A' })
  const relayBefore = reg.body.relayToken
  const userId = reg.body.teamAccountId

  // 第二台设备登录：relay 是 per-user 单值，保持不变
  const loginB = await loginUser(email, { deviceId: 'dev-B' })
  assert.equal(loginB.body.relayToken, relayBefore)

  // 撤销 dev-B 槽位
  const slotB = db.prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND device_id = ?').get(userId, 'dev-B')
  assert.ok(slotB)
  const revoke = await authRoutes.request(`/devices/${slotB.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${reg.body.accessToken}` },
  })
  assert.equal(revoke.status, 200)

  // 槽位删除
  const remain = db.prepare('SELECT device_id FROM refresh_tokens WHERE user_id = ?').all(userId)
  assert.ok(!remain.some((r) => r.device_id === 'dev-B'))

  // relay 已轮换：旧令牌反查不到用户，DB 中是新令牌
  assert.equal(dbModule.getUserByRelayToken(relayBefore), undefined)
  const user = db.prepare('SELECT relay_token FROM users WHERE id = ?').get(userId)
  assert.notEqual(user.relay_token, relayBefore)
})

test('登录 revokeSlotId 撤销设备：同样触发 relay 轮换', async () => {
  const email = 'auth-node-5@example.com'
  const reg = await registerUser(email, { deviceId: 'dev-C' })
  const relayBefore = reg.body.relayToken

  const slotC = db.prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND device_id = ?')
    .get(reg.body.teamAccountId, 'dev-C')

  const res = await loginUser(email, { deviceId: 'dev-D', revokeSlotId: slotC.id })
  assert.equal(res.status, 200)
  assert.match(res.body.relayToken, /^prelay_/)
  assert.notEqual(res.body.relayToken, relayBefore) // 撤销设备后签发新 relay
  assert.equal(dbModule.getUserByRelayToken(relayBefore), undefined)
})
