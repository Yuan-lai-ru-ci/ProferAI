/**
 * 团队文件 manifest 的稳定身份写入规则。
 * 覆盖同路径只更新内容投影，绝不替换整行；路径移动/重命名仅更新路径。
 */
import crypto from 'node:crypto'

function ensureDefaultMetadata(db, workspaceId, fileId, actorId, now) {
  // Phase 1 的独立 manifest 测试可不装 metadata 表；正式 schema 必定已迁移。
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_metadata'").get()
  if (!table) return
  db.prepare(`INSERT OR IGNORE INTO file_metadata (workspace_id, file_id, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?)`)
    .run(workspaceId, fileId, now, now, actorId)
}

/** 仅在目录不存在时创建，保留并发请求已创建目录的身份与归属。 */
export function ensureManifestDirectory(db, entry) {
  const now = entry.modifiedAt ?? Date.now()
  const candidateId = entry.fileId ?? crypto.randomUUID()
  db.prepare(`
    INSERT INTO file_manifests (
      workspace_id, file_path, file_name, is_directory, size, modified_at, sha256,
      uploaded_by, uploaded_by_name, file_id, created_by, created_at, updated_by
    ) VALUES (?, ?, ?, 1, 0, ?, '', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, file_path) DO NOTHING
  `).run(entry.workspaceId, entry.path, entry.name, now, entry.actorId, entry.actorName ?? '', candidateId, entry.actorId, now, entry.actorId)
  const row = db.prepare('SELECT file_id FROM file_manifests WHERE workspace_id = ? AND file_path = ?').get(entry.workspaceId, entry.path)
  ensureDefaultMetadata(db, entry.workspaceId, row.file_id, entry.actorId, now)
}

export function upsertManifestEntry(db, entry) {
  const now = entry.modifiedAt ?? Date.now()
  const fileId = entry.fileId ?? crypto.randomUUID()
  db.prepare(`
    INSERT INTO file_manifests (
      workspace_id, file_path, file_name, is_directory, size, modified_at, sha256,
      uploaded_by, uploaded_by_name, file_id, created_by, created_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, file_path) DO UPDATE SET
      file_name = excluded.file_name, is_directory = excluded.is_directory, size = excluded.size,
      modified_at = excluded.modified_at, sha256 = excluded.sha256, uploaded_by = excluded.uploaded_by,
      uploaded_by_name = excluded.uploaded_by_name, updated_by = excluded.updated_by
  `).run(entry.workspaceId, entry.path, entry.name, entry.isDirectory ? 1 : 0, entry.size ?? 0, now, entry.sha256 ?? '', entry.actorId, entry.actorName ?? '', fileId, entry.actorId, now, entry.actorId)
  const row = db.prepare('SELECT file_id FROM file_manifests WHERE workspace_id = ? AND file_path = ?').get(entry.workspaceId, entry.path)
  ensureDefaultMetadata(db, entry.workspaceId, row.file_id, entry.actorId, now)
}
