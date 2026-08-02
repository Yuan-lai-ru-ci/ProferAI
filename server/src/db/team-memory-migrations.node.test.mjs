import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { teamMemoryMigrations } from './team-memory-migrations.js'

test('团队共享记忆迁移创建版本化文档和修订表', () => {
  const db = new Database(':memory:')
  for (const migration of teamMemoryMigrations) migration.up(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name)
  assert.ok(tables.includes('team_memories'))
  assert.ok(tables.includes('team_memory_revisions'))
  db.prepare("INSERT INTO team_memories(id,workspace_id,path,title,created_by,updated_by,created_at,updated_at) VALUES('m1','w1','规范/a.md','A','u1','u1',1,1)").run()
  assert.equal(db.prepare("SELECT version FROM team_memories WHERE id='m1'").get().version, 1)
  assert.throws(() => db.prepare("INSERT INTO team_memories(id,workspace_id,path,title,created_by,updated_by,created_at,updated_at) VALUES('m2','w1','规范/a.md','B','u1','u1',1,1)").run())
})
