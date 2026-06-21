import { Hono } from 'hono'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'

export const invitationRoutes = new Hono()

/** 验证邀请 token */
invitationRoutes.get('/:token', (c) => {
  const inv = db.prepare(`
    SELECT i.*, w.name as workspace_name, u.display_name as inviter_name
    FROM invitations i
    JOIN workspaces w ON i.workspace_id = w.id
    JOIN users u ON i.inviter_id = u.id
    WHERE i.token = ?
  `).get(c.req.param('token'))

  if (!inv) return c.json({ error: '邀请不存在或已失效' }, 404)
  if (inv.status !== 'pending') return c.json({ error: '邀请已被处理' }, 410)
  if (inv.expires_at < Date.now()) return c.json({ error: '邀请已过期' }, 410)

  return c.json({
    workspaceId: inv.workspace_id,
    workspaceName: inv.workspace_name,
    inviterName: inv.inviter_name,
    role: inv.role,
    inviteeEmail: inv.invitee_email,
    expiresAt: inv.expires_at,
    valid: true,
  })
})

/** 接受邀请 */
invitationRoutes.post('/:token/accept', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const inv = db.prepare(`
    SELECT i.*, w.name as workspace_name, w.slug FROM invitations i
    JOIN workspaces w ON i.workspace_id = w.id
    WHERE i.token = ?
  `).get(c.req.param('token'))

  if (!inv) return c.json({ error: '邀请不存在' }, 404)
  if (inv.status !== 'pending') return c.json({ error: '邀请已被处理' }, 410)
  if (inv.expires_at < Date.now()) return c.json({ error: '邀请已过期' }, 410)

  const userId = c.get('userId')
  const userEmail = c.get('userEmail')

  if (inv.invitee_email !== userEmail) {
    return c.json({ error: '邀请邮箱与当前账户不匹配' }, 403)
  }

  const existing = db.prepare(
    'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(inv.workspace_id, userId)
  if (existing) return c.json({ error: '你已是该工作区成员' }, 409)

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(inv.workspace_id, userId, inv.role, Date.now())
    db.prepare(
      'UPDATE invitations SET status = ? WHERE id = ?'
    ).run('accepted', inv.id)
  })
  tx()

  return c.json({
    id: inv.workspace_id,
    name: inv.workspace_name,
    slug: inv.slug,
    type: 'team',
    role: inv.role,
  })
})

/** 拒绝邀请 */
invitationRoutes.post('/:token/decline', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(c.req.param('token'))
  if (!inv) return c.json({ error: '邀请不存在' }, 404)
  if (inv.status !== 'pending') return c.json({ error: '邀请已被处理' }, 410)

  const userEmail = c.get('userEmail')
  if (inv.invitee_email && inv.invitee_email !== userEmail) {
    return c.json({ error: '邀请邮箱与当前账户不匹配' }, 403)
  }

  db.prepare('UPDATE invitations SET status = ? WHERE id = ?').run('declined', inv.id)
  return c.json({ success: true })
})
