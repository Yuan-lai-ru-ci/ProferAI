/**
 * 公告路由
 *
 * GET  /v1/workspaces/:id/announcements     — 列表（置顶优先，按时间倒序）
 * POST /v1/workspaces/:id/announcements     — 创建（仅 owner/admin）
 * DELETE /v1/workspaces/:id/announcements/:aid — 删除（仅 owner/admin 或作者）
 */

import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'
import { broadcastEvent } from '../event-bus.js'

export const announcementRoutes = new Hono()

function requireWorkspaceMember(c, wsId) {
  const userId = c.get('userId')
  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)
  c.set('memberRole', member.role)
}

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin'
}

// ===== 列出公告 =====
announcementRoutes.get('/:id/announcements', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const denied = requireWorkspaceMember(c, wsId)
  if (denied) return denied

  const rows = db.prepare(`
    SELECT * FROM announcements
    WHERE workspace_id = ?
    ORDER BY is_pinned DESC, created_at DESC
    LIMIT 100
  `).all(wsId)

  return c.json(rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    authorId: r.author_id,
    authorName: r.author_name,
    title: r.title,
    content: r.content,
    isPinned: r.is_pinned !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })))
})

// ===== 创建公告 =====
announcementRoutes.post('/:id/announcements', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const denied = requireWorkspaceMember(c, wsId)
  if (denied) return denied

  const role = c.get('memberRole') || 'member'
  if (!isAdminOrOwner(role)) {
    return c.json({ error: '仅拥有者和管理员可发布公告' }, 403)
  }

  const body = (await c.req.json()) || {}
  const title = (body.title || '').trim()
  if (!title) return c.json({ error: '标题必填' }, 400)
  const content = (body.content || '').trim()
  const isPinned = !!body.isPinned

  const id = uuidv4()
  const userId = c.get('userId')
  const user = db.prepare('SELECT display_name, email FROM users WHERE id = ?').get(userId)
  const authorName = user?.display_name || c.get('userEmail') || ''
  const now = Date.now()

  db.prepare(`
    INSERT INTO announcements (id, workspace_id, author_id, author_name, title, content, is_pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, wsId, userId, authorName, title, content, isPinned ? 1 : 0, now, now)

  broadcastEvent(wsId, 'announcement_created', {
    id, title, authorName, isPinned, createdAt: now,
  })

  return c.json({ id, workspaceId: wsId, authorId: userId, authorName, title, content, isPinned, createdAt: now, updatedAt: now })
})

// ===== 删除公告 =====
announcementRoutes.delete('/:id/announcements/:aid', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const aid = c.req.param('aid')
  const denied = requireWorkspaceMember(c, wsId)
  if (denied) return denied

  const ann = db.prepare('SELECT * FROM announcements WHERE id = ? AND workspace_id = ?').get(aid, wsId)
  if (!ann) return c.json({ error: '公告不存在' }, 404)

  // 仅 owner/admin 或公告作者可删除
  const userId = c.get('userId')
  const role = c.get('memberRole') || 'member'
  if (!isAdminOrOwner(role) && ann.author_id !== userId) {
    return c.json({ error: '无权删除' }, 403)
  }

  db.prepare('DELETE FROM announcements WHERE id = ?').run(aid)

  broadcastEvent(wsId, 'announcement_deleted', { id: aid })

  return c.json({ success: true })
})
