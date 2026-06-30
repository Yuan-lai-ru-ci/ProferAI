import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from './config.js'
import { db, getUserByRelayToken } from './db.js'

// ===== CORS 中间件 =====
// 注：生产环境应通过 nginx 或反向代理限制 Origin，当前 * 通配符用于内网/开发环境。
export function corsMiddleware(c) {
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  // 安全响应头
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
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
    const h = hashToken(token)
    const blacklisted = db.prepare('SELECT 1 FROM token_blacklist WHERE token_hash = ?').get(h)
    if (blacklisted) {
      return c.json({ error: '令牌已注销' }, 401)
    }
    c.set('userId', payload.sub)
    c.set('userEmail', payload.email)
    c.set('accessToken', token)
    c.set('jwtPayload', payload)
  } catch {
    return c.json({ error: '令牌无效或已过期' }, 401)
  }
}

// Hono 标准中间件版本 — 供 app.use() 使用
export async function honoAuthMiddleware(c, next) {
  const result = authMiddleware(c)
  if (result) return result
  await next()
}

// ===== Proxy 专用认证中间件 =====
// 代管模式下客户端把长效 relay 令牌当作渠道 apiKey 长期持有，
// 用它打 /v1/proxy/*。relay 令牌不会像 1h 的 accessToken 那样过期，
// 避免 Agent 长任务中途 401。
//
// 兼容两种凭证：
//   1. relay 令牌（prelay_ 前缀）— 长效，反查用户
//   2. 标准 accessToken（JWT）— 回退，兼容旧客户端/调试
//
// 无论哪种，都把 jwtPayload.sub / userId 设成真实用户 ID，
// 确保下游 creditCheckMiddleware 和 proxy handler 能正确认人扣费。
export async function proxyAuthMiddleware(c, next) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401)
  }
  const token = auth.slice(7)

  // 优先按 relay 令牌处理（前缀识别，避免无谓的 JWT 验签）
  if (token.startsWith('prelay_')) {
    const user = getUserByRelayToken(token)
    if (!user) {
      return c.json({ error: 'relay 令牌无效' }, 401)
    }
    if (user.is_suspended) {
      return c.json({ error: '账号已被停用' }, 403)
    }
    // 与 JWT 路径保持同样的 context 形状，下游无需区分凭证来源
    c.set('userId', user.id)
    c.set('userEmail', user.email)
    c.set('jwtPayload', { sub: user.id, email: user.email, is_admin: !!user.is_admin })
    await next()
    return
  }

  // 回退：标准 JWT accessToken
  const result = authMiddleware(c)
  if (result) return result
  await next()
}
