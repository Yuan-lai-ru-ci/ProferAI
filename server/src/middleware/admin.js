/**
 * Admin 鉴权中间件 — 必须在 authMiddleware 之后挂载
 * 验证 JWT payload 中 is_admin === true
 */
export function adminMiddleware(c, next) {
  const payload = c.get('jwtPayload')
  if (!payload || !payload.is_admin) {
    return c.json({ error: '需要管理员权限' }, 403)
  }
  return next()
}
