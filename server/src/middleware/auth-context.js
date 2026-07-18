/**
 * 将数据库中的实时授权投影写入 Hono context。
 * JWT 只用于识别用户，禁止用其中可变 claims 作权限判断。
 */
export function applyCurrentAuthorization(c, user) {
  if (!user) {
    return c.json({ error: '账号不存在或已删除', code: 'ACCOUNT_NOT_FOUND' }, 401)
  }
  if (user.is_suspended) {
    return c.json({ error: '账号已被停用', code: 'ACCOUNT_SUSPENDED' }, 403)
  }

  const payload = {
    sub: user.id,
    email: user.email,
    is_admin: !!user.is_admin,
    membership_tier: user.membership_tier || 'free',
  }
  c.set('userId', user.id)
  c.set('userEmail', user.email)
  c.set('jwtPayload', payload)
  return null
}
