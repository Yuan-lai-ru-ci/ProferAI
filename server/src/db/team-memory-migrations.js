/** 团队共享知识记忆的版本化 SQLite 迁移。 */
export const teamMemoryMigrations = [
  {
    id: '20260802_02_team_shared_memory',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_memories (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          UNIQUE(workspace_id, path)
        );
        CREATE TABLE IF NOT EXISTS team_memory_revisions (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          content_snapshot TEXT NOT NULL,
          change_summary TEXT NOT NULL DEFAULT '',
          edited_by TEXT NOT NULL,
          edited_at INTEGER NOT NULL,
          UNIQUE(memory_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_team_memories_workspace_updated ON team_memories(workspace_id, archived_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_team_memories_workspace_path ON team_memories(workspace_id, path);
        CREATE INDEX IF NOT EXISTS idx_team_memory_revisions_memory_version ON team_memory_revisions(memory_id, version DESC);
      `)
    },
  },
]
