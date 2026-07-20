/** 团队资料库的版本化 SQLite 迁移。 */
import crypto from 'node:crypto'

function addColumnIfMissing(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  if (columns.some((column) => column.name === columnName)) return
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`)
}

function backfillStableFileIds(db) {
  const rows = db.prepare(`
    SELECT workspace_id, file_path FROM file_manifests
    WHERE file_id IS NULL OR file_id = ''
  `).all()
  const update = db.prepare(`
    UPDATE file_manifests SET file_id = ?
    WHERE workspace_id = ? AND file_path = ? AND (file_id IS NULL OR file_id = '')
  `)
  for (const row of rows) update.run(crypto.randomUUID(), row.workspace_id, row.file_path)
}

export const teamFileMigrations = [
  {
    id: '20260719_01_team_file_stable_identity',
    up(db) {
      addColumnIfMissing(db, 'file_manifests', 'file_id', 'file_id TEXT')
      addColumnIfMissing(db, 'file_manifests', 'created_by', "created_by TEXT NOT NULL DEFAULT ''")
      addColumnIfMissing(db, 'file_manifests', 'created_at', 'created_at INTEGER NOT NULL DEFAULT 0')
      addColumnIfMissing(db, 'file_manifests', 'updated_by', "updated_by TEXT NOT NULL DEFAULT ''")

      const now = Date.now()
      db.prepare(`
        UPDATE file_manifests
        SET created_by = CASE WHEN created_by = '' THEN uploaded_by ELSE created_by END,
            updated_by = CASE WHEN updated_by = '' THEN uploaded_by ELSE updated_by END,
            created_at = CASE WHEN created_at = 0 THEN modified_at ELSE created_at END
        WHERE created_by = '' OR updated_by = '' OR created_at = 0
      `).run()
      backfillStableFileIds(db)

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_file_manifests_workspace_file_id
        ON file_manifests(workspace_id, file_id)
      `)
      // 防御极端的 modified_at 为 0 的存量行，保持资料时间可排序。
      db.prepare('UPDATE file_manifests SET created_at = ? WHERE created_at = 0').run(now)
    },
  },
  {
    id: '20260719_02_team_file_metadata',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_file_tags (
          workspace_id TEXT NOT NULL, tag_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
          color TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
          archived_at INTEGER DEFAULT NULL,
          PRIMARY KEY (workspace_id, tag_id), UNIQUE (workspace_id, name)
        );
        CREATE TABLE IF NOT EXISTS workspace_file_statuses (
          workspace_id TEXT NOT NULL, status_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
          color TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, archived_at INTEGER DEFAULT NULL,
          created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
          PRIMARY KEY (workspace_id, status_id), UNIQUE (workspace_id, name)
        );
        CREATE TABLE IF NOT EXISTS file_metadata (
          workspace_id TEXT NOT NULL, file_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          status_id TEXT DEFAULT NULL, primary_owner_id TEXT DEFAULT NULL, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (workspace_id, file_id)
        );
        CREATE TABLE IF NOT EXISTS file_tag_links (
          workspace_id TEXT NOT NULL, file_id TEXT NOT NULL, tag_id TEXT NOT NULL,
          created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
          PRIMARY KEY (workspace_id, file_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS file_user_preferences (
          workspace_id TEXT NOT NULL, file_id TEXT NOT NULL, user_id TEXT NOT NULL,
          is_favorite INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER DEFAULT NULL,
          PRIMARY KEY (workspace_id, file_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS file_activities (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, file_id TEXT NOT NULL, actor_id TEXT DEFAULT NULL,
          type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_metadata_status ON file_metadata(workspace_id, status_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_file_metadata_owner ON file_metadata(workspace_id, primary_owner_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_file_activities_time ON file_activities(workspace_id, file_id, created_at DESC, id DESC);
      `)
      const now = Date.now()
      db.prepare(`
        INSERT OR IGNORE INTO file_metadata (workspace_id, file_id, created_at, updated_at, updated_by)
        SELECT workspace_id, file_id, created_at, created_at, created_by
        FROM file_manifests WHERE file_id IS NOT NULL AND file_id != ''
      `).run()
      db.prepare('UPDATE file_metadata SET updated_at = ? WHERE updated_at = 0').run(now)
    },
  },
  {
    id: '20260720_03_team_file_trash',
    up(db) {
      addColumnIfMissing(db, 'file_manifests', 'lifecycle_state', "lifecycle_state TEXT NOT NULL DEFAULT 'active'")
      addColumnIfMissing(db, 'file_manifests', 'trash_entry_id', 'trash_entry_id TEXT DEFAULT NULL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_trash_entries (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, root_file_id TEXT NOT NULL,
          original_path TEXT NOT NULL, deleted_by TEXT NOT NULL, deleted_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'trashed',
          restored_path TEXT DEFAULT NULL, restored_by TEXT DEFAULT NULL, restored_at INTEGER DEFAULT NULL,
          purged_at INTEGER DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_trash_expiry ON file_trash_entries(state, expires_at);
        CREATE INDEX IF NOT EXISTS idx_file_trash_workspace ON file_trash_entries(workspace_id, deleted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_file_manifests_active ON file_manifests(workspace_id, lifecycle_state, modified_at DESC);
      `)
    },
  },
]
