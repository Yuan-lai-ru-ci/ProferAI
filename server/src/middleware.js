import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from './config.js'
import { db } from './db.js'

// ===== CORS 中间件 =====
export function corsMiddleware(c) {
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204 })
}

/** token 哈希，用于黑名单查重 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// ===== JWT 认证中间件 =====
export function authMiddleware(c) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401)
  }
  const token = auth.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET)

    // 检查黑名单
    const h = hashToken(token)
    const blacklisted = db.prepare('SELECT 1 FROM token_blacklist WHERE token_hash = ?').get(h)
    if (blacklisted) {
      return c.json({ error: '令牌已注销' }, 401)
    }

    c.set('userId', payload.sub)
    c.set('userEmail', payload.email)
    c.set('accessToken', token) // 供 logout 使用
  } catch {
    return c.json({ error: '令牌无效或已过期' }, 401)
  }
}
