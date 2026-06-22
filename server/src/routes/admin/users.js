/**
 * Admin 用户管理路由 — 需要 authMiddleware + adminMiddleware
 */
import { Hono } from 'hono'
import { listAllUsers, getUserById, updateUser, promoteUser, demoteUser } from '../../db.js'
import { logAudit } from '../../audit.js'

export const adminUsers = new Hono()

// GET /v1/admin/users — 用户列表（支持 ?search=&page=&limit=）
adminUsers.get('/', (c) => {
  const search = c.req.query('search') || ''
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)
  const result = listAllUsers({ search, page, limit })
  return c.json(result)
})

// GET /v1/admin/users/:id — 用户详情
adminUsers.get('/:id', (c) => {
  const user = getUserById(c.req.param('id'))
  if (!user) return c.json({ error: '用户不存在' }, 404)
  // 脱敏：不返回 password_hash
  const { password_hash, ...safe } = user
  return c.json(safe)
})

// PATCH /v1/admin/users/:id — 修改用户
adminUsers.patch('/:id', async (c) => {
  const targetId = c.req.param('id')
  const adminId = c.get('userId')
  if (targetId === adminId) return c.json({ error: '不能修改自己的账户' }, 400)

  const body = await c.req.json()
  const result = updateUser(targetId, body)
  if (!result) return c.json({ error: '没有可更新的字段' }, 400)

  logAudit({ action: 'admin.update_user', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId, detail: JSON.stringify(body) })
  return c.json({ success: true })
})

// POST /v1/admin/users/:id/promote — 提升为管理员
adminUsers.post('/:id/promote', (c) => {
  const targetId = c.req.param('id')
  const adminId = c.get('userId')
  promoteUser(targetId)
  logAudit({ action: 'admin.promote_user', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId })
  return c.json({ success: true })
})

// POST /v1/admin/users/:id/demote — 撤销管理员
adminUsers.post('/:id/demote', (c) => {
  const targetId = c.req.param('id')
  const adminId = c.get('userId')
  if (targetId === adminId) return c.json({ error: '不能撤销自己的管理员权限' }, 400)
  demoteUser(targetId)
  logAudit({ action: 'admin.demote_user', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId })
  return c.json({ success: true })
})
