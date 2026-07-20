import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db.js'
import { ONLINE_THRESHOLD, INVITATION_TTL, WORKSPACE_GRACE_PERIOD_MS, getSubscriptionCap } from '../config.js'
import { authMiddleware } from '../middleware.js'
import { logAudit } from '../audit.js'
import { broadcastEvent } from '../event-bus.js'
import { clearPrimaryOwnerForRemovedMember } from '../team-files/metadata-service.js'

export const workspaceRoutes = new Hono()

// ===== 列出用户的工作区 =====
workspaceRoutes.get('/', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const includeDeleted = c.req.query('include_deleted') === 'true'

  let whereClause = 'w.is_deleted = 0'
  const params = [userId]

  if (includeDeleted) {
    const graceCutoff = Date.now() - WORKSPACE_GRACE_PERIOD_MS
    whereClause = '(w.is_deleted = 0 OR (w.is_deleted = 1 AND w.deleted_at > ?))'
    params.push(graceCutoff)
  }

  const rows = db.prepare(`
    SELECT w.*, wm.role FROM workspaces w
    JOIN workspace_members wm ON w.id = wm.workspace_id
    WHERE wm.user_id = ? AND ${whereClause}
    ORDER BY w.updated_at DESC
  `).all(...params)

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
    isDeleted: r.is_deleted !== 0,
    deletedAt: r.deleted_at || undefined,
    restoredAt: r.restored_at || undefined,
    expiresAt: r.is_deleted && r.deleted_at ? r.deleted_at + WORKSPACE_GRACE_PERIOD_MS : undefined,
  })))
})

/** 校验当前用户是否工作区成员，并将角色存入上下文供后续鉴权 */
function requireWorkspaceMember(c) {
  const wsId = c.req.param('id')
  const userId = c.get('userId')
  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)
  c.set('memberRole', member.role)
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

  // 审计仅限本工作区：不再让 owner/admin 借 workspace_id='' 跨工作区看到全站登录/登出记录和他人邮箱
  const whereClause = 'workspace_id = ?'
  const params = [wsId]

  const rows = db.prepare(`
    SELECT action, user_email, entity_type, entity_id, detail, created_at
    FROM audit_logs
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit)

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

  // 团队工作区数量配额：按 membership_tier 限制
  const user = db.prepare('SELECT membership_tier FROM users WHERE id = ?').get(userId)
  const tier = user?.membership_tier || 'free'
  const cap = getSubscriptionCap(tier)
  if (cap.maxWorkspaces !== Infinity) {
    const count = db.prepare(
      'SELECT COUNT(*) as c FROM workspaces WHERE owner_id = ? AND is_deleted = 0'
    ).get(userId).c
    if (count >= cap.maxWorkspaces) {
      return c.json({
        error: `当前订阅等级（${tier}）最多创建 ${cap.maxWorkspaces} 个团队工作区，您已有 ${count} 个。请升级订阅以创建更多工作区。`,
        code: 'workspace_limit',
        currentTier: tier,
        maxWorkspaces: cap.maxWorkspaces,
      }, 403)
    }
  }

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

  const now = Date.now()
  db.prepare('UPDATE workspaces SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, wsId)
  logAudit({ action: 'workspace.delete', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'workspace', entityId: wsId, detail: `grace period until ${now + WORKSPACE_GRACE_PERIOD_MS}` })
  broadcastEvent(wsId, 'workspace_updated', { action: 'deleted', userId, expiresAt: now + WORKSPACE_GRACE_PERIOD_MS })
  return c.json({ success: true })
})

// ===== 恢复已删除工作区（冷静期内） =====
workspaceRoutes.post('/:id/restore', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const userId = c.get('userId')
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId)
  if (!member || member.role !== 'owner') return c.json({ error: '仅拥有者可恢复' }, 403)

  const ws = db.prepare('SELECT is_deleted, deleted_at FROM workspaces WHERE id = ?').get(wsId)
  if (!ws) return c.json({ error: '工作区不存在' }, 404)
  if (!ws.is_deleted) return c.json({ error: '工作区未被删除，无需恢复' }, 400)

  const graceCutoff = Date.now() - WORKSPACE_GRACE_PERIOD_MS
  if (ws.deleted_at && ws.deleted_at <= graceCutoff) {
    return c.json({ error: '冷静期已过，无法恢复' }, 410)
  }

  const now = Date.now()
  db.prepare('UPDATE workspaces SET is_deleted = 0, deleted_at = NULL, restored_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, wsId)
  logAudit({ action: 'workspace.restore', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'workspace', entityId: wsId })
  broadcastEvent(wsId, 'workspace_updated', { action: 'restored', userId, restoredAt: now })
  return c.json({ success: true, id: wsId, restoredAt: now })
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
  broadcastEvent(wsId, 'member_changed', { action: 'invited', inviteeEmail: email || 'public', role: role || 'member', userId: inviterId })

  return c.json({ id, token, workspaceId: wsId, inviteeEmail: email || '', role: role || 'member', status: 'pending', expiresAt: now + INVITATION_TTL })
})

// ===== 邀请列表（支持状态过滤与分页） =====
workspaceRoutes.get('/:id/invitations', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const userId = c.get('userId')

  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)

  const status = c.req.query('status')
  const hasFilterParams = status || c.req.query('page') || c.req.query('limit')

  // 构建条件
  const conditions = ['i.workspace_id = ?']
  const params = [wsId]

  if (status && ['pending', 'accepted', 'declined', 'expired', 'cancelled'].includes(status)) {
    conditions.push('i.status = ?')
    params.push(status)
  }

  const whereClause = conditions.join(' AND ')

  // 无过滤参数时保持旧数组返回格式（向后兼容）
  if (!hasFilterParams) {
    const rows = db.prepare(`
      SELECT i.*, u.display_name as inviter_name
      FROM invitations i
      JOIN users u ON i.inviter_id = u.id
      WHERE ${whereClause}
      ORDER BY i.created_at DESC
    `).all(...params)

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
  }

  // 带过滤参数时返回分页结构
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
  const offset = (page - 1) * limit

  const total = db.prepare(`SELECT COUNT(*) as total FROM invitations i WHERE ${whereClause}`).get(...params).total

  const rows = db.prepare(`
    SELECT i.*, u.display_name as inviter_name
    FROM invitations i
    JOIN users u ON i.inviter_id = u.id
    WHERE ${whereClause}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  return c.json({
    invitations: rows.map((r) => ({
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
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  })
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
  broadcastEvent(wsId, 'member_changed', { action: 'invitation_cancelled', invitationId, userId })
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
  broadcastEvent(wsId, 'member_changed', { action: 'role_updated', targetUserId: targetUid, role, userId })
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

  const target = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, targetUid)
  if (!target) return c.json({ error: '成员不存在' }, 404)
  // 当前 owner 必须先完成所有权转让，不能被管理员直接移除，否则工作区会失去可治理的 owner。
  if (target.role === 'owner') return c.json({ error: '拥有者需先转让所有权' }, 400)

  // 清理负责人和移除成员必须原子完成，避免资料留下不可分配的已离开成员。
  let clearedOwnerCount = 0
  db.transaction(() => {
    clearedOwnerCount = clearPrimaryOwnerForRemovedMember(db, { workspaceId: wsId, userId: targetUid, actorId: userId })
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, targetUid)
  })()
  logAudit({ action: 'member.remove', workspaceId: wsId, userId, userEmail: c.get('userEmail'), entityType: 'member', entityId: targetUid })
  broadcastEvent(wsId, 'member_changed', { action: 'removed', targetUserId: targetUid, userId })
  if (clearedOwnerCount) broadcastEvent(wsId, 'file_metadata_updated', { action: 'owners_cleared', actorId: userId, affectedCount: clearedOwnerCount })
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

  let clearedOwnerCount = 0
  db.transaction(() => {
    clearedOwnerCount = clearPrimaryOwnerForRemovedMember(db, { workspaceId: wsId, userId, actorId: userId })
    db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(wsId, userId)
  })()
  broadcastEvent(wsId, 'member_changed', { action: 'left', userId })
  if (clearedOwnerCount) broadcastEvent(wsId, 'file_metadata_updated', { action: 'owners_cleared', actorId: userId, affectedCount: clearedOwnerCount })
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
  broadcastEvent(wsId, 'member_changed', { action: 'ownership_transferred', fromUserId: userId, toUserId: targetUserId })

  return c.json({ success: true })
})
