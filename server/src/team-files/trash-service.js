import crypto from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname, join, posix } from 'node:path'

export const TRASH_RETENTION_MS = 7 * 86400 * 1000
function trashRoot(filesDir) { return join(filesDir, '.trash') }
function activePath(filesDir, workspaceId, filePath) { return join(filesDir, workspaceId, filePath) }
function entryPath(filesDir, workspaceId, entryId, filePath) { return join(trashRoot(filesDir), workspaceId, entryId, filePath) }
// 已回收 manifest 使用服务端私有路径投影，释放原路径唯一键给新的活跃资料。
function trashedManifestPath(entryId, originalPath) { return `__trash__/${entryId}/${originalPath}` }
function activity(db, workspaceId, fileId, actorId, type, payload, now) { db.prepare('INSERT INTO file_activities (id, workspace_id, file_id, actor_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), workspaceId, fileId, actorId, type, JSON.stringify(payload), now) }

function restoreCandidate(originalPath, sequence) {
  if (!sequence) return originalPath
  const parsed = posix.parse(originalPath)
  const extension = extname(originalPath)
  const suffix = sequence === 1 ? '（已恢复）' : `（已恢复） ${sequence}`
  const name = `${parsed.name}${suffix}${extension}`
  return parsed.dir ? posix.join(parsed.dir, name) : name
}

function hasRestoreConflict(db, filesDir, workspaceId, candidateRoot, rows, sourcePrefix) {
  if (existsSync(activePath(filesDir, workspaceId, candidateRoot))) return true
  const active = db.prepare("SELECT 1 FROM file_manifests WHERE workspace_id = ? AND lifecycle_state = 'active' AND file_path = ?")
  for (const row of rows) {
    const candidatePath = row.file_path === sourcePrefix ? candidateRoot : candidateRoot + row.file_path.slice(sourcePrefix.length)
    if (active.get(workspaceId, candidatePath)) return true
  }
  return false
}

function allocateRestorePath(db, filesDir, workspaceId, originalPath, rows, sourcePrefix) {
  for (let sequence = 0; sequence < 10_000; sequence++) {
    const candidate = restoreCandidate(originalPath, sequence)
    if (!hasRestoreConflict(db, filesDir, workspaceId, candidate, rows, sourcePrefix)) return candidate
  }
  throw Object.assign(new Error('无法分配恢复副本路径'), { code: 'RESTORE_PATH_EXHAUSTED' })
}

export function moveToTrash(db, { filesDir, workspaceId, filePath, actorId, now = Date.now() }) {
  const children = db.prepare("SELECT * FROM file_manifests WHERE workspace_id = ? AND lifecycle_state = 'active' AND (file_path = ? OR file_path LIKE ?)").all(workspaceId, filePath, `${filePath}/%`)
  if (!children.length) throw Object.assign(new Error('文件不存在'), { code: 'FILE_NOT_FOUND' })
  const entryId = crypto.randomUUID()
  const source = activePath(filesDir, workspaceId, filePath)
  const target = entryPath(filesDir, workspaceId, entryId, filePath)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); renameSync(source, target) }
  try {
    db.transaction(() => {
      const root = children.find((row) => row.file_path === filePath)
      db.prepare('INSERT INTO file_trash_entries (id, workspace_id, root_file_id, original_path, deleted_by, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(entryId, workspaceId, root.file_id, filePath, actorId, now, now + TRASH_RETENTION_MS)
      const update = db.prepare("UPDATE file_manifests SET file_path = ?, lifecycle_state = 'trashed', trash_entry_id = ? WHERE workspace_id = ? AND file_id = ?")
      for (const child of children) {
        update.run(trashedManifestPath(entryId, child.file_path), entryId, workspaceId, child.file_id)
        activity(db, workspaceId, child.file_id, actorId, 'trashed', { entryId }, now)
      }
    })()
  } catch (error) {
    if (existsSync(target) && !existsSync(source)) { mkdirSync(dirname(source), { recursive: true }); renameSync(target, source) }
    throw error
  }
  return { entryId, children, expiresAt: now + TRASH_RETENTION_MS }
}

export function restoreTrash(db, { filesDir, workspaceId, entryId, actorId, now = Date.now() }) {
  const entry = db.prepare("SELECT * FROM file_trash_entries WHERE id = ? AND workspace_id = ? AND state = 'trashed'").get(entryId, workspaceId)
  if (!entry) throw Object.assign(new Error('回收站条目不存在'), { code: 'TRASH_NOT_FOUND' })
  const rows = db.prepare("SELECT file_id, file_path FROM file_manifests WHERE workspace_id = ? AND trash_entry_id = ? AND lifecycle_state = 'trashed'").all(workspaceId, entryId)
  if (!rows.length) throw Object.assign(new Error('回收站资料不完整'), { code: 'TRASH_INCONSISTENT' })
  const sourcePrefix = trashedManifestPath(entryId, entry.original_path)
  const path = allocateRestorePath(db, filesDir, workspaceId, entry.original_path, rows, sourcePrefix)
  const source = entryPath(filesDir, workspaceId, entryId, entry.original_path)
  const target = activePath(filesDir, workspaceId, path)
  if (existsSync(source)) { mkdirSync(dirname(target), { recursive: true }); renameSync(source, target) }
  try {
    db.transaction(() => {
      const update = db.prepare("UPDATE file_manifests SET file_path = ?, file_name = ?, lifecycle_state = 'active', trash_entry_id = NULL, modified_at = ? WHERE workspace_id = ? AND file_id = ?")
      for (const row of rows) {
        const next = row.file_path === sourcePrefix ? path : path + row.file_path.slice(sourcePrefix.length)
        update.run(next, posix.basename(next), now, workspaceId, row.file_id)
        activity(db, workspaceId, row.file_id, actorId, 'restored', { entryId, path: next }, now)
      }
      db.prepare("UPDATE file_trash_entries SET state = 'restored', restored_path = ?, restored_by = ?, restored_at = ? WHERE id = ?").run(path, actorId, now, entryId)
    })()
  } catch (error) {
    if (existsSync(target) && !existsSync(source)) { mkdirSync(dirname(source), { recursive: true }); renameSync(target, source) }
    throw error
  }
  return { restoredPath: path }
}

export function purgeExpiredTrash(db, { filesDir, now = Date.now() }) {
  const entries = db.prepare("SELECT id, workspace_id FROM file_trash_entries WHERE state = 'trashed' AND expires_at <= ?").all(now)
  let purgedCount = 0
  for (const entry of entries) {
    try { purgeTrash(db, { filesDir, workspaceId: entry.workspace_id, entryId: entry.id, now }); purgedCount++ }
    catch (error) { console.warn(`[回收站] 清理条目 ${entry.id} 失败:`, error.message) }
  }
  return purgedCount
}

export function purgeTrash(db, { filesDir, workspaceId, entryId, now = Date.now() }) {
  const entry = db.prepare("SELECT * FROM file_trash_entries WHERE id = ? AND workspace_id = ?").get(entryId, workspaceId)
  if (!entry || entry.state === 'purged') return { state: 'already_purged' }
  const root = entryPath(filesDir, workspaceId, entryId, entry.original_path)
  rmSync(root, { recursive: true, force: true })
  db.transaction(() => {
    const rows = db.prepare('SELECT file_id FROM file_manifests WHERE workspace_id = ? AND trash_entry_id = ?').all(workspaceId, entryId)
    for (const row of rows) {
      db.prepare('DELETE FROM file_tag_links WHERE workspace_id = ? AND file_id = ?').run(workspaceId, row.file_id)
      db.prepare('DELETE FROM file_user_preferences WHERE workspace_id = ? AND file_id = ?').run(workspaceId, row.file_id)
      db.prepare('DELETE FROM file_metadata WHERE workspace_id = ? AND file_id = ?').run(workspaceId, row.file_id)
      db.prepare('DELETE FROM file_activities WHERE workspace_id = ? AND file_id = ?').run(workspaceId, row.file_id)
    }
    db.prepare('DELETE FROM file_manifests WHERE workspace_id = ? AND trash_entry_id = ?').run(workspaceId, entryId)
    db.prepare("UPDATE file_trash_entries SET state = 'purged', purged_at = ? WHERE id = ?").run(now, entryId)
  })()
  return { state: 'purged' }
}
