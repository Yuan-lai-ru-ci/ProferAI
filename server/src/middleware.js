import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { JWT_SECRET } from './config.js'
import { db, getUserByRelayToken, getApiKeyByHash } from './db.js'

// ===== CORS 中间件 =====
// 注：生产环境应通过 nginx 或反向代理限制 Origin，当前 * 通配符用于内网/开发环境。
export function corsMiddleware(c) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }
  for (const [k, v] of Object.entries(headers)) {
    c.res.headers.set(k, v)
  }
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers })
  }
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
// 确保下游 proxy handler 能正确认人扣费。
export async function proxyAuthMiddleware(c, next) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401)
  }
  const token = auth.slice(7)

  // 开放 API：用户自建 pk_ key（前缀识别）
  // 只反查用户，绝不等于平台 RELAY_API_KEY；转发仍由 proxy handler 用服务端持有的 key 完成。
  if (token.startsWith('pk_')) {
    const rec = getApiKeyByHash(hashToken(token))
    if (!rec) {
      return c.json({ error: 'API Key 无效' }, 401)
    }
    if (rec.status !== 'active') {
      return c.json({ error: 'API Key 已停用' }, 403)
    }
    if (rec.is_suspended) {
      return c.json({ error: '账号已被停用' }, 403)
    }
    // key 级限额：设了上限且已超，直接拒（quota 单位）
    if (rec.quota_limit != null && rec.quota_used >= rec.quota_limit) {
      return c.json({ error: 'API Key 额度已用尽', code: 'apikey_quota_exceeded' }, 402)
    }
    // 与 JWT 路径保持同样的 context 形状；额外挂 apiKeyId 供 handler 计费后累加用量
    c.set('userId', rec.user_id)
    c.set('jwtPayload', { sub: rec.user_id, membership_tier: rec.membership_tier || 'free' })
    c.set('apiKeyId', rec.id)
    await next()
    return
  }

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
    c.set('jwtPayload', { sub: user.id, email: user.email, is_admin: !!user.is_admin, membership_tier: user.membership_tier || 'free' })
    await next()
    return
  }

  // 回退：标准 JWT accessToken
  const result = authMiddleware(c)
  if (result) return result
  await next()
}
