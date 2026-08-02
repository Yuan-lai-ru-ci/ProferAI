import { Hono } from 'hono'
import crypto from 'node:crypto'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'
import { logAudit } from '../audit.js'
import { broadcastEvent } from '../event-bus.js'

export const teamMemoryRoutes = new Hono()
const MAX_PATH = 300
const MAX_TITLE = 160
const MAX_CONTENT = 1024 * 1024

function memberAccess(c) {
  const workspaceId = c.req.param('id')
  const member = db.prepare(`SELECT wm.role FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.workspace_id=? AND wm.user_id=? AND w.is_deleted=0`).get(workspaceId, c.get('userId'))
  return member ? { workspaceId, role: member.role } : null
}
function isAdmin(role) { return role === 'owner' || role === 'admin' }
async function jsonBody(c) { try { const value = await c.req.json(); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null } }
function normalizePath(value) {
  if (typeof value !== 'string') return null
  const path = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (!path || path.length > MAX_PATH || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) return null
  return path
}
function dto(row) { return { id: row.id, path: row.path, title: row.title, content: row.content, version: row.version, createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at ?? undefined } }
function summary(row) { const { content, ...rest } = dto(row); return rest }
function emit(workspaceId, userId, email, memory, action) {
  logAudit({ action: `team_memory.${action}`, workspaceId, userId, userEmail: email || '', entityType: 'team_memory', entityId: memory.id, detail: memory.path })
  broadcastEvent(workspaceId, 'team_memory_changed', { memoryId: memory.id, action, actorId: userId, version: memory.version })
}
function revision(memory, actorId, changeSummary, at) {
  db.prepare('INSERT INTO team_memory_revisions(id,memory_id,workspace_id,version,content_snapshot,change_summary,edited_by,edited_at) VALUES(?,?,?,?,?,?,?,?)').run(crypto.randomUUID(), memory.id, memory.workspace_id, memory.version, memory.content, changeSummary || '', actorId, at)
}

teamMemoryRoutes.get('/:id/memories', (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const access = memberAccess(c); if (!access) return c.json({ error: '无权访问工作区' }, 403)
  const archived = c.req.query('includeArchived') === 'true'
  const rows = db.prepare(`SELECT * FROM team_memories WHERE workspace_id=? ${archived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC`).all(access.workspaceId)
  return c.json(rows.map(summary))
})
teamMemoryRoutes.get('/:id/memories/:memoryId', (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const access = memberAccess(c); if (!access) return c.json({ error: '无权访问工作区' }, 403)
  const row = db.prepare('SELECT * FROM team_memories WHERE workspace_id=? AND id=?').get(access.workspaceId, c.req.param('memoryId'))
  return row ? c.json(dto(row)) : c.json({ error: '团队记忆不存在' }, 404)
})
teamMemoryRoutes.post('/:id/memories', async (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const access = memberAccess(c); if (!access) return c.json({ error: '无权访问工作区' }, 403)
  const body = await jsonBody(c), path = normalizePath(body?.path)
  if (!body || !path || typeof body.title !== 'string' || !body.title.trim() || body.title.length > MAX_TITLE || typeof body.content !== 'string' || body.content.length > MAX_CONTENT) return c.json({ error: '团队记忆参数非法' }, 400)
  const now = Date.now(), id = crypto.randomUUID(), userId = c.get('userId')
  try { db.transaction(() => { db.prepare('INSERT INTO team_memories(id,workspace_id,path,title,content,version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)').run(id, access.workspaceId, path, body.title.trim(), body.content, userId, userId, now, now); const row = db.prepare('SELECT * FROM team_memories WHERE id=?').get(id); revision(row, userId, body.changeSummary, now) })() } catch (error) { return c.json({ error: String(error).includes('UNIQUE') ? '团队记忆路径已存在' : '创建团队记忆失败' }, 409) }
  const row = db.prepare('SELECT * FROM team_memories WHERE id=?').get(id); emit(access.workspaceId, userId, c.get('userEmail'), row, 'create'); return c.json(dto(row), 201)
})
teamMemoryRoutes.patch('/:id/memories/:memoryId', async (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const access = memberAccess(c); if (!access) return c.json({ error: '无权访问工作区' }, 403)
  const body = await jsonBody(c)
  if (!body || !Number.isInteger(body.expectedVersion)) return c.json({ error: '需提供 expectedVersion' }, 400)
  const old = db.prepare('SELECT * FROM team_memories WHERE workspace_id=? AND id=?').get(access.workspaceId, c.req.param('memoryId'))
  if (!old) return c.json({ error: '团队记忆不存在' }, 404)
  // 归档表示治理冻结；须先由管理员恢复，避免隐藏文档继续被普通成员修改。
  if (old.archived_at) return c.json({ error: '团队记忆已归档，请联系管理员恢复后再编辑' }, 409)
  if (old.version !== body.expectedVersion) return c.json({ error: '团队记忆已被其他成员修改', code: 'TEAM_MEMORY_VERSION_CONFLICT', current: dto(old) }, 409)
  const path = body.path === undefined ? old.path : normalizePath(body.path)
  const title = body.title === undefined ? old.title : (typeof body.title === 'string' ? body.title.trim() : '')
  const content = body.content === undefined ? old.content : body.content
  if (!path || !title || title.length > MAX_TITLE || typeof content !== 'string' || content.length > MAX_CONTENT) return c.json({ error: '团队记忆参数非法' }, 400)
  const now = Date.now(), userId = c.get('userId')
  try { const changed = db.transaction(() => { const result = db.prepare('UPDATE team_memories SET path=?,title=?,content=?,version=version+1,updated_by=?,updated_at=? WHERE workspace_id=? AND id=? AND version=?').run(path, title, content, userId, now, access.workspaceId, old.id, body.expectedVersion); if (!result.changes) return null; const row = db.prepare('SELECT * FROM team_memories WHERE id=?').get(old.id); revision(row, userId, body.changeSummary, now); return row })(); if (!changed) { const current = db.prepare('SELECT * FROM team_memories WHERE id=?').get(old.id); return c.json({ error: '团队记忆已被其他成员修改', code: 'TEAM_MEMORY_VERSION_CONFLICT', current: dto(current) }, 409) }; emit(access.workspaceId, userId, c.get('userEmail'), changed, 'update'); return c.json(dto(changed)) } catch (error) { return c.json({ error: String(error).includes('UNIQUE') ? '团队记忆路径已存在' : '更新团队记忆失败' }, 409) }
})
teamMemoryRoutes.get('/:id/memories/:memoryId/revisions', (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const access = memberAccess(c); if (!access) return c.json({ error: '无权访问工作区' }, 403)
  const memory = db.prepare('SELECT id FROM team_memories WHERE workspace_id=? AND id=?').get(access.workspaceId, c.req.param('memoryId')); if (!memory) return c.json({ error: '团队记忆不存在' }, 404)
  return c.json(db.prepare('SELECT id,version,change_summary AS changeSummary,edited_by AS editedBy,edited_at AS editedAt FROM team_memory_revisions WHERE workspace_id=? AND memory_id=? ORDER BY version DESC').all(access.workspaceId, memory.id))
})
function adminLifecycle(action, archived) { return async (c) => { const mw = authMiddleware(c); if (mw) return mw; const access = memberAccess(c); if (!access || !isAdmin(access.role)) return c.json({ error: '仅管理员可执行此操作' }, 403); const old = db.prepare('SELECT * FROM team_memories WHERE workspace_id=? AND id=?').get(access.workspaceId, c.req.param('memoryId')); if (!old) return c.json({ error: '团队记忆不存在' }, 404); const now = Date.now(), userId = c.get('userId'); db.prepare('UPDATE team_memories SET archived_at=?,updated_by=?,updated_at=? WHERE id=?').run(archived ? now : null, userId, now, old.id); const row = db.prepare('SELECT * FROM team_memories WHERE id=?').get(old.id); emit(access.workspaceId, userId, c.get('userEmail'), row, action); return c.json(dto(row)) } }
teamMemoryRoutes.post('/:id/memories/:memoryId/archive', adminLifecycle('archive', true))
teamMemoryRoutes.post('/:id/memories/:memoryId/unarchive', adminLifecycle('unarchive', false))
