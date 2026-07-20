import crypto from 'node:crypto'

function assertResource(db, workspaceId, fileId) {
  const resource = db.prepare("SELECT * FROM file_manifests WHERE workspace_id = ? AND file_id = ? AND lifecycle_state = 'active'").get(workspaceId, fileId)
  if (!resource) throw Object.assign(new Error('资料不存在'), { code: 'FILE_NOT_FOUND' })
  return resource
}

function addActivity(db, { workspaceId, fileId, actorId, type, payload = {}, now = Date.now() }) {
  db.prepare(`INSERT INTO file_activities (id, workspace_id, file_id, actor_id, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), workspaceId, fileId, actorId, type, JSON.stringify(payload), now)
}

export function getMetadataDetail(db, workspaceId, fileId, viewerId) {
  const resource = assertResource(db, workspaceId, fileId)
  const metadata = db.prepare('SELECT * FROM file_metadata WHERE workspace_id = ? AND file_id = ?').get(workspaceId, fileId)
  const tags = db.prepare(`SELECT t.tag_id AS id, t.name, t.color FROM file_tag_links l
    JOIN workspace_file_tags t ON t.workspace_id = l.workspace_id AND t.tag_id = l.tag_id
    WHERE l.workspace_id = ? AND l.file_id = ? ORDER BY t.name COLLATE NOCASE`).all(workspaceId, fileId)
  const preference = db.prepare('SELECT is_favorite, last_accessed_at FROM file_user_preferences WHERE workspace_id = ? AND file_id = ? AND user_id = ?').get(workspaceId, fileId, viewerId)
  return { resource, metadata, tags, preference: preference || { is_favorite: 0, last_accessed_at: null } }
}

export function patchMetadata(db, { workspaceId, fileId, actorId, expectedVersion, changes }) {
  assertResource(db, workspaceId, fileId)
  const current = db.prepare('SELECT * FROM file_metadata WHERE workspace_id = ? AND file_id = ?').get(workspaceId, fileId)
  if (!current) throw Object.assign(new Error('资料尚未初始化'), { code: 'METADATA_NOT_READY' })
  if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) {
    throw Object.assign(new Error('资料已被他人更新'), { code: 'METADATA_VERSION_CONFLICT' })
  }
  const now = Date.now()
  const changedFields = []
  const next = { description: current.description, statusId: current.status_id, primaryOwnerId: current.primary_owner_id }
  if ('description' in changes) { next.description = changes.description; changedFields.push('description') }
  if ('statusId' in changes) { next.statusId = changes.statusId; changedFields.push('statusId') }
  if ('primaryOwnerId' in changes) { next.primaryOwnerId = changes.primaryOwnerId; changedFields.push('primaryOwnerId') }
  if (next.statusId && !db.prepare('SELECT 1 FROM workspace_file_statuses WHERE workspace_id = ? AND status_id = ? AND archived_at IS NULL').get(workspaceId, next.statusId)) throw Object.assign(new Error('状态不可用'), { code: 'INVALID_STATUS' })
  if (next.primaryOwnerId && !db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, next.primaryOwnerId)) throw Object.assign(new Error('负责人必须是当前成员'), { code: 'INVALID_OWNER' })
  if ('tagIds' in changes) {
    for (const tagId of changes.tagIds) if (!db.prepare('SELECT 1 FROM workspace_file_tags WHERE workspace_id = ? AND tag_id = ? AND archived_at IS NULL').get(workspaceId, tagId)) throw Object.assign(new Error('标签不可用'), { code: 'INVALID_TAG' })
    changedFields.push('tagIds')
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE file_metadata SET description = ?, status_id = ?, primary_owner_id = ?, updated_at = ?, updated_by = ?, version = version + 1
      WHERE workspace_id = ? AND file_id = ?`).run(next.description, next.statusId, next.primaryOwnerId, now, actorId, workspaceId, fileId)
    if ('tagIds' in changes) {
      db.prepare('DELETE FROM file_tag_links WHERE workspace_id = ? AND file_id = ?').run(workspaceId, fileId)
      const insert = db.prepare('INSERT INTO file_tag_links (workspace_id, file_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      for (const tagId of changes.tagIds) insert.run(workspaceId, fileId, tagId, now, actorId)
    }
    if (changedFields.length) addActivity(db, { workspaceId, fileId, actorId, type: 'metadata_updated', payload: { changedFields }, now })
  })
  tx()
  return getMetadataDetail(db, workspaceId, fileId, actorId)
}

export function listActivities(db, { workspaceId, fileId, cursor, limit = 50 }) {
  assertResource(db, workspaceId, fileId)
  const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50))
  let parsed = null
  if (cursor) {
    try {
      const candidate = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (!candidate || !Number.isFinite(candidate.createdAt) || typeof candidate.id !== 'string') throw new Error('invalid cursor')
      parsed = candidate
    } catch {
      throw Object.assign(new Error('活动分页游标无效'), { code: 'INVALID_CURSOR' })
    }
  }
  const rows = db.prepare(`SELECT id, actor_id, type, payload_json, created_at FROM file_activities
    WHERE workspace_id = ? AND file_id = ? AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(workspaceId, fileId, parsed?.createdAt ?? null, parsed?.createdAt ?? 0, parsed?.createdAt ?? 0, parsed?.id ?? '', safeLimit)
  const last = rows.at(-1)
  return { activities: rows.map((row) => ({ id: row.id, actorId: row.actor_id, type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at })), nextCursor: rows.length === safeLimit ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url') : null }
}

export function setPreference(db, { workspaceId, fileId, userId, isFavorite, accessedAt }) {
  assertResource(db, workspaceId, fileId)
  const current = db.prepare('SELECT * FROM file_user_preferences WHERE workspace_id = ? AND file_id = ? AND user_id = ?').get(workspaceId, fileId, userId)
  const favorite = isFavorite === undefined ? (current?.is_favorite ?? 0) : Number(Boolean(isFavorite))
  const accessed = accessedAt === undefined ? current?.last_accessed_at ?? null : Math.max(current?.last_accessed_at ?? 0, accessedAt || 0) || null
  db.prepare(`INSERT INTO file_user_preferences (workspace_id, file_id, user_id, is_favorite, last_accessed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, file_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, last_accessed_at = excluded.last_accessed_at`).run(workspaceId, fileId, userId, favorite, accessed)
}

export function clearPrimaryOwnerForRemovedMember(db, { workspaceId, userId, actorId }) {
  const rows = db.prepare('SELECT file_id FROM file_metadata WHERE workspace_id = ? AND primary_owner_id = ?').all(workspaceId, userId)
  const now = Date.now()
  const update = db.prepare('UPDATE file_metadata SET primary_owner_id = NULL, updated_at = ?, updated_by = ?, version = version + 1 WHERE workspace_id = ? AND file_id = ?')
  for (const row of rows) { update.run(now, actorId, workspaceId, row.file_id); addActivity(db, { workspaceId, fileId: row.file_id, actorId, type: 'owner_cleared', payload: { removedUserId: userId }, now }) }
  return rows.length
}
