/**
 * Admin 鉴权中间件 — 必须在 authMiddleware 之后挂载
 * 验证认证中间件写入的实时授权快照中的 is_admin === true
 */
export function adminMiddleware(c, next) {
  const payload = c.get('jwtPayload')
  if (!payload || !payload.is_admin) {
    return c.json({ error: '未授权访问' }, 403)
  }
  return next()
}
