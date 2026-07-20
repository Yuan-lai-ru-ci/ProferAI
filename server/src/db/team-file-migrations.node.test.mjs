/** 团队资料库稳定身份迁移：Node 内置测试，使用内存 SQLite。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from './migration-runner.js'
import { teamFileMigrations } from './team-file-migrations.js'

function createLegacyDatabase() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE file_manifests (
      workspace_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      is_directory INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER NOT NULL,
      sha256 TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL DEFAULT '',
      uploaded_by_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, file_path)
    )
  `)
  return db
}

test('Given 旧版 manifest When 执行稳定身份迁移 Then 每项获得唯一 fileId 和创建/更新归属', () => {
  const db = createLegacyDatabase()
  try {
    db.prepare(`
      INSERT INTO file_manifests (workspace_id, file_path, file_name, modified_at, uploaded_by)
      VALUES (?, ?, ?, ?, ?)
    `).run('ws-1', '资料/方案.md', '方案.md', 1000, 'user-1')

    runMigrations(db, teamFileMigrations)
    const row = db.prepare('SELECT file_id, created_by, created_at, updated_by FROM file_manifests').get()

    assert.match(row.file_id, /^[0-9a-f-]{36}$/)
    assert.equal(row.created_by, 'user-1')
    assert.equal(row.updated_by, 'user-1')
    assert.equal(row.created_at, 1000)
  } finally {
    db.close()
  }
})

test('Given 已迁移的 manifest When 重复执行迁移 Then 原 fileId 不变且只保留一条迁移记录', () => {
  const db = createLegacyDatabase()
  try {
    db.prepare(`
      INSERT INTO file_manifests (workspace_id, file_path, file_name, modified_at, uploaded_by)
      VALUES (?, ?, ?, ?, ?)
    `).run('ws-1', '资料/方案.md', '方案.md', 1000, 'user-1')

    runMigrations(db, teamFileMigrations)
    const firstId = db.prepare('SELECT file_id FROM file_manifests').get().file_id
    runMigrations(db, teamFileMigrations)
    const secondId = db.prepare('SELECT file_id FROM file_manifests').get().file_id
    const appliedCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count

    assert.equal(secondId, firstId)
    assert.equal(appliedCount, teamFileMigrations.length)
  } finally {
    db.close()
  }
})
