/**
 * 注册原子性 — New API 建号失败不得残留半注册用户。
 *
 * 场景：COMMERCIAL_MODE=true + PER_USER_NEWAPI_KEY=true
 *  - NEWAPI_ADMIN_TOKEN 留空 → provisionNewApiUser 在 adminPost 处立即返回
 *    { ok:false, reason:'no_admin_token' }（不抛、无网络），触发 503 分支
 *  - 断言：users / refresh_tokens / invite_codes / invite_records 均无残留
 */
process.env.JWT_SECRET = 'x'.repeat(64)
process.env.DB_PATH = ':memory:'
process.env.COMMERCIAL_MODE = 'true'
process.env.PER_USER_NEWAPI_KEY = 'true' // 同步建号路径：失败阻塞注册
process.env.CHANNEL_ENCRYPTION_KEY = 'y'.repeat(64)
process.env.RELAY_API_KEY = 'test-relay-key'
process.env.RELAY_BASE_URL = 'http://127.0.0.1:9'
process.env.NEWAPI_ADMIN_TOKEN = '' // 关键：让 adminPost 直接返回 no_admin_token

import test from 'node:test'
import assert from 'node:assert/strict'
import { v4 as uuidv4 } from 'uuid'

const dbModule = await import('../db.js')
const { authRoutes } = await import('./auth.js')
const db = dbModule.db

test('New API 建号失败：注册返回 503 且 DB 无残留用户', async () => {
  const email = 'auth-register-fail@example.com'
  const code = `TEST-ACT-${uuidv4().slice(0, 8)}`
  db.prepare(
    `INSERT INTO activation_codes (id, code, status, created_at) VALUES (?, ?, 'pending', ?)`
  ).run(uuidv4(), code, Date.now())

  const res = await authRoutes.request('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Passw0rd123',
      displayName: 'failcase',
      activationCode: code,
      deviceId: 'dev-register-fail',
      deviceName: 'Test Machine',
      platform: 'win32',
      appVersion: '0.0.0-test',
    }),
  })
  assert.equal(res.status, 503)

  // 用户本身不残留（修复前：user 已插入但注册提示失败）
  assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get(email), undefined)
  // 设备槽位 / 邀请码 / 邀请事件也不残留
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ?').get(email).c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM invite_codes WHERE user_id = ?').get(email).c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM invite_records WHERE invitee_id = ?').get(email).c, 0)
})
