import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { JWT_SECRET, ALLOWED_ORIGIN } from './config.js'
import { db, getCurrentUserAuthorization, getUserByRelayToken, getApiKeyByHash } from './db.js'
import { applyCurrentAuthorization } from './middleware/auth-context.js'
import { applyCorsHeaders as applyConfiguredCorsHeaders, applySecurityHeaders } from './middleware/cors.js'

// ===== CORS 中间件 =====
// 通过 ALLOWED_ORIGIN 环境变量控制，生产环境应设为具体域名。
// 若未设置且非开发环境，默认收紧为不设置该头（拒绝跨域）。
export function applyCorsHeaders(c, allowedOrigin = ALLOWED_ORIGIN) {
  applyConfiguredCorsHeaders(c, allowedOrigin)
}

export function corsMiddleware(c) {
  applyConfiguredCorsHeaders(c, ALLOWED_ORIGIN)
  // 安全响应头（始终设置，无论是否跨域）
  applySecurityHeaders(c)

  if (c.req.method === 'OPTIONS') {
    // 直接返回 Response 时显式带上前面写入的 CORS/安全头。
    return new Response(null, { status: 204, headers: c.res.headers })
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
    const authorization = getCurrentUserAuthorization(payload.sub)
    const authorizationResult = applyCurrentAuthorization(c, authorization)
    if (authorizationResult) return authorizationResult
    c.set('accessToken', token)
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
    const authorizationResult = applyCurrentAuthorization(c, {
      id: rec.authorization_user_id,
      email: rec.email,
      is_admin: rec.is_admin,
      is_suspended: rec.is_suspended,
      membership_tier: rec.membership_tier,
    })
    if (authorizationResult) return authorizationResult
    // key 级限额：设了上限且已超，直接拒（quota 单位）
    if (rec.quota_limit != null && rec.quota_used >= rec.quota_limit) {
      return c.json({ error: 'API Key 额度已用尽', code: 'apikey_quota_exceeded' }, 402)
    }
    // 与 JWT 路径保持同样的实时授权 context；额外挂 apiKeyId 供 handler 计费后累加用量。
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
    const authorizationResult = applyCurrentAuthorization(c, user)
    if (authorizationResult) return authorizationResult
    await next()
    return
  }

  // 回退：标准 JWT accessToken
  const result = authMiddleware(c)
  if (result) return result
  await next()
}
