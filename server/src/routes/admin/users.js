/**
 * Admin 用户管理路由 — 需要 authMiddleware + adminMiddleware
 */
import { Hono } from 'hono'
import { listAllUsers, getUserById, updateUser, promoteUser, demoteUser, deleteUser, db } from '../../db.js'
import { logAudit } from '../../audit.js'
import { disableNewApiTokens, rotateNewApiToken } from '../../newapi-client.js'
import { PER_USER_NEWAPI_KEY } from '../../config.js'

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
  // 脱敏：不返回 password_hash 和 new_api_key_encrypted
  const { password_hash, new_api_key_encrypted, ...safe } = user
  // 补充计算字段
  safe.hasNewApiKey = !!new_api_key_encrypted
  safe.newApiUserId = user.new_api_user_id || null
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
  try {
    demoteUser(targetId)
  } catch (e) {
    if (e.message === 'CANNOT_DEMOTE_LAST_ADMIN') return c.json({ error: '不能撤销最后一位管理员' }, 400)
    throw e
  }
  logAudit({ action: 'admin.demote_user', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId })
  return c.json({ success: true })
})

// DELETE /v1/admin/users/:id — 彻底删除用户（清除关联数据）
adminUsers.delete('/:id', async (c) => {
  const targetId = c.req.param('id')
  const adminId = c.get('userId')
  if (targetId === adminId) return c.json({ error: '不能删除自己的账户' }, 400)

  const user = getUserById(targetId)
  if (!user) return c.json({ error: '用户不存在' }, 404)
  if (user.is_admin) return c.json({ error: '不能删除管理员账户，请先撤销管理员权限' }, 400)

  // 清理 New API 侧 Token（fire-and-forget，不阻塞删除）
  if (PER_USER_NEWAPI_KEY && user.new_api_user_id) {
    disableNewApiTokens(user.new_api_user_id).then(r => {
      if (!r.ok) console.warn(`[admin.deleteUser] New API Token 禁用失败 (user=${user.email}, newApiId=${user.new_api_user_id}): ${r.error}`)
      else console.log(`[admin.deleteUser] 已禁用 ${r.disabledCount} 个 New API Token (user=${user.email})`)
    }).catch(e => {
      console.warn(`[admin.deleteUser] New API 清理异常 (user=${user.email}): ${e.message}`)
    })
  }

  deleteUser(targetId)
  logAudit({ action: 'admin.delete_user', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId, detail: `deleted: ${user.email}` })
  return c.json({ success: true })
})

// POST /v1/admin/users/:id/rotate-newapi-key — 轮换用户 New API Key
adminUsers.post('/:id/rotate-newapi-key', async (c) => {
  const targetId = c.req.param('id')
  const adminId = c.get('userId')

  if (!PER_USER_NEWAPI_KEY) {
    return c.json({ error: 'PER_USER_NEWAPI_KEY 未启用' }, 400)
  }

  const user = getUserById(targetId)
  if (!user) return c.json({ error: '用户不存在' }, 404)

  if (!user.new_api_user_id) {
    return c.json({ error: '该用户没有关联的 New API 账号' }, 400)
  }

  const result = await rotateNewApiToken(user.new_api_user_id, user.new_api_key_encrypted || null)
  if (!result.ok) {
    console.error(`[admin.rotateNewApiKey] 轮换失败 (user=${user.email}): ${result.error}`)
    return c.json({ error: 'Key 轮换失败，请检查 New API 连接' }, 500)
  }

  // 回写新 Key 到 Profer DB
  db.prepare('UPDATE users SET new_api_key_encrypted = ? WHERE id = ?')
    .run(result.newTokenKey, targetId)

  logAudit({ action: 'admin.rotate_newapi_key', userId: adminId, userEmail: c.get('userEmail'), entityType: 'user', entityId: targetId, detail: `rotated NewAPI key for: ${user.email}` })
  return c.json({ success: true, message: 'Key 已轮换，新 Key 下次请求生效' })
})