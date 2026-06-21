import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db.js'
import { ONLINE_THRESHOLD, INVITATION_TTL } from '../config.js'
import { authMiddleware } from '../middleware.js'
import { logAudit } from '../audit.js'

export const workspaceRoutes = new Hono()

// ===== 列出用户的工作区 =====
workspaceRoutes.get('/', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const rows = db.prepare(`
    SELECT w.*, wm.role FROM workspaces w
    JOIN workspace_members wm ON w.id = wm.workspace_id
    WHERE wm.user_id = ? AND w.is_deleted = 0
    ORDER BY w.updated_at DESC
  `).all(userId)

  return c.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    type: 'team',
    teamId: r.id,
    role: r.role,
    visibility: r.visibility,
    brand: r.brand ? JSON.parse(r.brand) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })))
})

/** 校验当前用户是否工作区成员 */
function requireWorkspaceMember(c) {
  const wsId = c.req.param('id')
  const userId = c.get('userId')
  const member = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)
}

// ===== 审计日志 =====
workspaceRoutes.get('/:id/audit-logs', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  const denied = requireWorkspaceMember(c)
  if (denied) return denied

  const wsId = c.req.param('id')
  const rawLimit = parseInt(c.req.query('limit') || '50', 10)
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200)

  const rows = db.prepare(`
    SELECT action, user_email, entity_type, entity_id, detail, created_at
    FROM audit_logs
    WHERE workspace_id = ? OR workspace_id = ''
    ORDER BY created_at DESC
    LIMIT ?
  `).all(wsId, limit)

  return c.json(rows)
})

// ===== 使用统计 =====
workspaceRoutes.get('/:id/stats', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  const denied = requireWorkspaceMember(c)
  if (denied) return denied

  const wsId = c.req.param('id')

  const totalSize = db.prepare(
    'SELECT COALESCE(SUM(size), 0) as total FROM file_manifests WHERE workspace_id = ?'
  ).get(wsId)?.total || 0

  const fileCount = db.prepare(
    'SELECT COUNT(*) as count FROM file_manifests WHERE workspace_id = ? AND is_directory = 0'
  ).get(wsId)?.count || 0

  const dirCount = db.prepare(
    'SELECT COUNT(*) as count FROM file_manifests WHERE workspace_id = ? AND is_directory = 1'
  ).get(wsId)?.count || 0

  const memberCount = db.prepare(
    'SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ?'
  ).get(wsId)?.count || 0

  const onlineCount = db.prepare(
    `SELECT COUNT(*) as count FROM workspace_members
     WHERE workspace_id = ? AND last_seen_at > ?`
  ).get(wsId, Date.now() - 120_000)?.count || 0

  const pendingInvites = db.prepare(
    "SELECT COUNT(*) as count FROM invitations WHERE workspace_id = ? AND status = 'pending'"
  ).get(wsId)?.count || 0

  return c.json({
    totalSize,
    fileCount,
    dirCount,
    memberCount,
    onlineCount,
    pendingInvites,
  })
})

// ===== 创建工作区 =====
workspaceRoutes.post('/', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const { name } = (await c.req.json()) || {}
  if (!name) return c.json({ error: '工作区名称必填' }, 400)

  const id = uuidv4()
  const slug = `team-${id.slice(0, 8)}`
  const now = Date.now()

  db.prepare(
    'INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, slug, userId, now, now)

  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, 'owner', now)
  logAudit({ action: 'workspace.create', workspaceId: id, userId, userEmail: c.get('userEmail'), entityType: 'workspace', entityId: id, detail: `created workspace: ${name}` })

  return c.json({ id, name, slug, type: 'team', teamId: id, role: 'owner', createdAt: now, updatedAt: now })
})

// ===== 删除工作区 =====
workspaceRoutes.delete('/:id', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const userId = c.get('userId')
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member || member.role !== 'owner') return c.json({ error: '仅拥有者可删除' }, 403)

  db.prepare('UPDATE workspaces SET is_deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), wsId)
  logAudit({ action: 'workspace.delete', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'workspace', entityId: wsId })
  return c.json({ success: true })
})

// ===== 成员列表 =====
workspaceRoutes.get('/:id/members', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  const denied = requireWorkspaceMember(c)
  if (denied) return denied

  const rows = db.prepare(`
    SELECT u.id as userId, u.display_name as displayName, u.avatar, wm.role, wm.joined_at as joinedAt, wm.last_seen_at as lastSeenAt
    FROM workspace_members wm JOIN users u ON wm.user_id = u.id
    WHERE wm.workspace_id = ?
  `).all(c.req.param('id'))

  const now = Date.now()

  return c.json(rows.map((r) => ({
    userId: r.userId,
    displayName: r.displayName,
    avatar: r.avatar,
    role: r.role,
    joinedAt: r.joinedAt,
    lastSeenAt: r.lastSeenAt,
    isOnline: r.lastSeenAt ? (now - r.lastSeenAt < ONLINE_THRESHOLD) : false,
  })))
})

// ===== 邀请成员 =====
workspaceRoutes.post('/:id/members', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const { email, role } = (await c.req.json()) || {}

  const inviterId = c.get('userId')
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, inviterId)
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return c.json({ error: '无邀请权限' }, 403)
  }

  const token = uuidv4()
  const id = uuidv4()
  const now = Date.now()

  db.prepare(
    'INSERT INTO invitations (id, workspace_id, inviter_id, invitee_email, role, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, wsId, inviterId, email || '', role || 'member', token, now, now + INVITATION_TTL)
  logAudit({ action: 'member.invite', workspaceId: wsId, userId: inviterId, userEmail: c.get('userEmail'), entityType: 'invitation', entityId: id, detail: `invited ${email || 'public'} as ${role || 'member'}` })

  return c.json({ id, token, workspaceId: wsId, inviteeEmail: email || '', role: role || 'member', status: 'pending', expiresAt: now + INVITATION_TTL })
})

// ===== 邀请列表 =====
workspaceRoutes.get('/:id/invitations', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const userId = c.get('userId')

  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)

  const rows = db.prepare(`
    SELECT i.*, u.display_name as inviter_name
    FROM invitations i
    JOIN users u ON i.inviter_id = u.id
    WHERE i.workspace_id = ?
    ORDER BY i.created_at DESC
  `).all(wsId)

  return c.json(rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    inviterId: r.inviter_id,
    inviterName: r.inviter_name,
    inviteeEmail: r.invitee_email,
    role: r.role,
    token: r.token,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  })))
})

// ===== 取消邀请 =====
workspaceRoutes.delete('/:id/invitations/:invitationId', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const invitationId = c.req.param('invitationId')
  const userId = c.get('userId')

  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return c.json({ error: '无取消邀请权限' }, 403)
  }

  const inv = db.prepare(
    'SELECT * FROM invitations WHERE id = ? AND workspace_id = ?'
  ).get(invitationId, wsId)
  if (!inv) return c.json({ error: '邀请不存在' }, 404)
  if (inv.status !== 'pending') return c.json({ error: '邀请已被处理' }, 410)

  db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run('cancelled', invitationId)
  logAudit({ action: 'member.cancel_invitation', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'invitation', entityId: invitationId })
  return c.json({ success: true })
})

// ===== 修改成员角色 =====
workspaceRoutes.patch('/:id/members/:uid', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const targetUid = c.req.param('uid')
  const { role } = (await c.req.json()) || {}

  const userId = c.get('userId')
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member || member.role !== 'owner') return c.json({ error: '仅拥有者可修改角色' }, 403)

  db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, wsId, targetUid)
  logAudit({ action: 'member.update_role', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'member', entityId: targetUid, detail: `role changed to ${role}` })
  return c.json({ success: true })
})

// ===== 移除成员 =====
workspaceRoutes.delete('/:id/members/:uid', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const targetUid = c.req.param('uid')
  const userId = c.get('userId')

  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return c.json({ error: '无移除权限' }, 403)
  }

  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, targetUid)
  logAudit({ action: 'member.remove', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'member', entityId: targetUid })
  return c.json({ success: true })
})

// ===== 退出工作区 =====
workspaceRoutes.post('/:id/leave', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const userId = c.get('userId')

  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 404)
  if (member.role === 'owner') return c.json({ error: '拥有者需先转让所有权' }, 400)

  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, userId)
  return c.json({ success: true })
})

// ===== 转让所有权 =====
workspaceRoutes.post('/:id/transfer-ownership', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const { targetUserId } = (await c.req.json()) || {}
  const userId = c.get('userId')

  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member || member.role !== 'owner') return c.json({ error: '仅拥有者可转让' }, 403)

  // 校验目标用户是工作区成员
  const target = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, targetUserId)
  if (!target) return c.json({ error: '目标用户不是工作区成员' }, 400)
  if (targetUserId === userId) return c.json({ error: '不能转让给自己' }, 400)

  const tx = db.transaction(() => {
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run('admin', wsId, userId)
    db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run('owner', wsId, targetUserId)
    db.prepare('UPDATE workspaces SET owner_id = ? WHERE id = ?').run(targetUserId, wsId)
  })
  tx()
  logAudit({ action: 'member.transfer_ownership', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'member', entityId: targetUserId })

  return c.json({ success: true })
})
