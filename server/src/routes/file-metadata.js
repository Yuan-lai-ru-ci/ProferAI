import { Hono } from 'hono'
import crypto from 'node:crypto'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'
import { logAudit } from '../audit.js'
import { broadcastEvent } from '../event-bus.js'
import { getMetadataDetail, listActivities, patchMetadata, setPreference } from '../team-files/metadata-service.js'

export const fileMetadataRoutes = new Hono()

function member(c, workspaceId) {
  return db.prepare(`
    SELECT wm.role
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.workspace_id = ? AND wm.user_id = ? AND w.is_deleted = 0
  `).get(workspaceId, c.get('userId')) || null
}

function dto(detail) {
  return {
    fileId: detail.resource.file_id,
    path: detail.resource.file_path,
    description: detail.metadata.description,
    statusId: detail.metadata.status_id,
    primaryOwnerId: detail.metadata.primary_owner_id,
    version: detail.metadata.version,
    tags: detail.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
    preference: {
      isFavorite: Boolean(detail.preference.is_favorite),
      lastAccessedAt: detail.preference.last_accessed_at,
    },
  }
}

function isAdmin(role) {
  return role === 'owner' || role === 'admin'
}

async function readJsonBody(c) {
  try {
    const body = await c.req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '请求体必须是 JSON 对象' }
    return { body }
  } catch {
    return { error: '请求体必须是有效 JSON' }
  }
}

function errorStatus(error, fallback = 400) {
  if (error?.code === 'METADATA_VERSION_CONFLICT') return 409
  if (error?.code === 'FILE_NOT_FOUND') return 404
  if (error?.code === 'INVALID_CURSOR') return 400
  return fallback
}

function requireMember(c, workspaceId) {
  const access = member(c, workspaceId)
  return access || null
}

fileMetadataRoutes.get('/:id/files/:fileId/metadata', (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const workspaceId = c.req.param('id')
  if (!requireMember(c, workspaceId)) return c.json({ error: '无权访问工作区' }, 403)
  try {
    return c.json(dto(getMetadataDetail(db, workspaceId, c.req.param('fileId'), c.get('userId'))))
  } catch (error) {
    return c.json({ error: error.message, code: error.code }, errorStatus(error, 404))
  }
})

fileMetadataRoutes.patch('/:id/files/:fileId/metadata', async (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const workspaceId = c.req.param('id')
  if (!requireMember(c, workspaceId)) return c.json({ error: '无权访问工作区' }, 403)
  const parsed = await readJsonBody(c)
  if (parsed.error) return c.json({ error: parsed.error }, 400)
  const body = parsed.body
  if ('description' in body && (typeof body.description !== 'string' || body.description.length > 2000)) return c.json({ error: '描述最长 2000 字' }, 400)
  if ('tagIds' in body && (!Array.isArray(body.tagIds) || new Set(body.tagIds).size !== body.tagIds.length || body.tagIds.some((id) => typeof id !== 'string'))) return c.json({ error: '标签不合法' }, 400)
  try {
    const result = patchMetadata(db, { workspaceId, fileId: c.req.param('fileId'), actorId: c.get('userId'), expectedVersion: body.expectedVersion, changes: body })
    const changedFields = Object.keys(body).filter((key) => key !== 'expectedVersion')
    logAudit({ action: 'file.metadata.update', workspaceId, userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'file', entityId: c.req.param('fileId'), detail: changedFields.join(',') })
    broadcastEvent(workspaceId, 'file_metadata_updated', { fileId: c.req.param('fileId'), version: result.metadata.version, changedFields, actorId: c.get('userId') })
    return c.json(dto(result))
  } catch (error) {
    return c.json({ error: error.message, code: error.code }, errorStatus(error))
  }
})

fileMetadataRoutes.put('/:id/files/:fileId/preference', async (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const workspaceId = c.req.param('id')
  if (!requireMember(c, workspaceId)) return c.json({ error: '无权访问工作区' }, 403)
  const parsed = await readJsonBody(c)
  if (parsed.error) return c.json({ error: parsed.error }, 400)
  try {
    setPreference(db, { workspaceId, fileId: c.req.param('fileId'), userId: c.get('userId'), ...parsed.body })
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error.message, code: error.code }, errorStatus(error, 404))
  }
})

fileMetadataRoutes.get('/:id/files/:fileId/activities', (c) => {
  const mw = authMiddleware(c); if (mw) return mw
  const workspaceId = c.req.param('id')
  if (!requireMember(c, workspaceId)) return c.json({ error: '无权访问工作区' }, 403)
  const rawLimit = c.req.query('limit') || '50'
  if (!/^\d+$/.test(rawLimit)) return c.json({ error: 'limit 必须是正整数' }, 400)
  try {
    return c.json(listActivities(db, { workspaceId, fileId: c.req.param('fileId'), cursor: c.req.query('cursor'), limit: Number(rawLimit) }))
  } catch (error) {
    return c.json({ error: error.message, code: error.code }, errorStatus(error, 404))
  }
})

for (const [plural, table, key] of [['file-tags', 'workspace_file_tags', 'tag_id'], ['file-statuses', 'workspace_file_statuses', 'status_id']]) {
  fileMetadataRoutes.get(`/:id/${plural}`, (c) => {
    const mw = authMiddleware(c); if (mw) return mw
    const workspaceId = c.req.param('id')
    if (!requireMember(c, workspaceId)) return c.json({ error: '无权访问工作区' }, 403)
    const position = table === 'workspace_file_statuses' ? ', position' : ''
    const order = table === 'workspace_file_statuses' ? 'position,' : ''
    return c.json(db.prepare(`SELECT ${key} AS id, name, color${position} FROM ${table} WHERE workspace_id = ? AND archived_at IS NULL ORDER BY ${order} name COLLATE NOCASE`).all(workspaceId))
  })
  fileMetadataRoutes.post(`/:id/${plural}`, async (c) => {
    const mw = authMiddleware(c); if (mw) return mw
    const workspaceId = c.req.param('id')
    const access = requireMember(c, workspaceId)
    if (!access) return c.json({ error: '无权访问工作区' }, 403)
    if (!isAdmin(access.role)) return c.json({ error: '仅 Owner/Admin 可管理字典' }, 403)
    const parsed = await readJsonBody(c)
    if (parsed.error) return c.json({ error: parsed.error }, 400)
    const body = parsed.body
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) return c.json({ error: '名称不合法' }, 400)
    const id = crypto.randomUUID()
    try {
      if (table === 'workspace_file_statuses') db.prepare(`INSERT INTO ${table} (workspace_id, ${key}, name, color, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, id, body.name.trim(), body.color || '', Number.isInteger(body.position) ? body.position : 0, Date.now(), c.get('userId'))
      else db.prepare(`INSERT INTO ${table} (workspace_id, ${key}, name, color, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`).run(workspaceId, id, body.name.trim(), body.color || '', Date.now(), c.get('userId'))
      return c.json({ id }, 201)
    } catch {
      return c.json({ error: '名称已存在' }, 409)
    }
  })
}
