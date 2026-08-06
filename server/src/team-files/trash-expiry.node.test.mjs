/**
 * 回收站 7 天保留期自动清理（purgeExpiredTrash）测试
 *
 * 与 trash-service.node.test.mjs 同风格：真实文件系统 + better-sqlite3 内存库。
 * 覆盖 08-03 事故链条末端：到期条目自动清理、未到期保留、混合场景、幂等。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../db/migration-runner.js'
import { teamFileMigrations } from '../db/team-file-migrations.js'
import { moveToTrash, purgeExpiredTrash } from './trash-service.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'profer-trash-expiry-'))
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE file_manifests (workspace_id TEXT NOT NULL,file_path TEXT NOT NULL,file_name TEXT NOT NULL,is_directory INTEGER NOT NULL DEFAULT 0,size INTEGER NOT NULL DEFAULT 0,modified_at INTEGER NOT NULL,sha256 TEXT NOT NULL DEFAULT '',uploaded_by TEXT NOT NULL DEFAULT '',uploaded_by_name TEXT NOT NULL DEFAULT '',PRIMARY KEY(workspace_id,file_path));`)
  runMigrations(db, teamFileMigrations)
  return {
    db, root,
    // 创建一条真实文件并移入回收站
    trashFile(workspaceId, relativePath, opts = {}) {
      mkdirSync(join(root, workspaceId), { recursive: true })
      writeFileSync(join(root, workspaceId, relativePath), 'content')
      db.prepare(`INSERT INTO file_manifests (workspace_id,file_path,file_name,modified_at,uploaded_by,file_id) VALUES (?,?,?,?,?,?)`)
        .run(workspaceId, relativePath, relativePath.split('/').pop(), 1, 'creator', crypto.randomUUID())
      const result = moveToTrash(db, { filesDir: root, workspaceId, filePath: relativePath, actorId: 'creator', now: opts.now ?? 100 })
      if (opts.expiresAt !== undefined) {
        db.prepare('UPDATE file_trash_entries SET expires_at = ? WHERE id = ?').run(opts.expiresAt, result.entryId)
      }
      return result
    },
    close() { db.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('Given 过期回收站条目 When 清理任务运行 Then 文件与记录被移除且状态置为 purged', () => {
  const x = setup()
  try {
    const entry = x.trashFile('ws', '旧文档.md', { now: 100, expiresAt: 100 + 7 * 86400 * 1000 })
    const past = 100 + 7 * 86400 * 1000 + 1 // 已过保留期
    const purged = purgeExpiredTrash(x.db, { filesDir: x.root, now: past })

    assert.equal(purged, 1)
    assert.equal(existsSync(join(x.root, '.trash', 'ws', entry.entryId, '旧文档.md')), false, '磁盘文件应被删除')
    assert.equal(x.db.prepare("SELECT COUNT(*) c FROM file_manifests WHERE trash_entry_id = ?").get(entry.entryId).c, 0, 'manifest 应被删除')
    const row = x.db.prepare("SELECT state FROM file_trash_entries WHERE id = ?").get(entry.entryId)
    assert.equal(row.state, 'purged')
  } finally { x.close() }
})

test('Given 未到期回收站条目 When 清理任务运行 Then 文件与记录保留原样', () => {
  const x = setup()
  try {
    const entry = x.trashFile('ws', '新文档.md', { now: 100, expiresAt: 100 + 7 * 86400 * 1000 })
    const before = 100 + 7 * 86400 * 1000 - 1 // 仍在保留期内
    const purged = purgeExpiredTrash(x.db, { filesDir: x.root, now: before })

    assert.equal(purged, 0)
    assert.equal(existsSync(join(x.root, '.trash', 'ws', entry.entryId, '新文档.md')), true, '文件应保留在回收站')
    assert.equal(x.db.prepare("SELECT state FROM file_trash_entries WHERE id = ?").get(entry.entryId).state, 'trashed')
  } finally { x.close() }
})

test('Given 过期与未到期混合 When 清理 Then 仅清理过期条目', () => {
  const x = setup()
  try {
    const expiredEntry = x.trashFile('ws', '过期.md', { now: 100, expiresAt: 100 + 7 * 86400 * 1000 })
    const activeEntry = x.trashFile('ws', '未过期.md', { now: 200, expiresAt: 200 + 7 * 86400 * 1000 })
    const past = 100 + 7 * 86400 * 1000 + 1

    const purged = purgeExpiredTrash(x.db, { filesDir: x.root, now: past })

    assert.equal(purged, 1)
    assert.equal(x.db.prepare("SELECT state FROM file_trash_entries WHERE id = ?").get(expiredEntry.entryId).state, 'purged')
    assert.equal(x.db.prepare("SELECT state FROM file_trash_entries WHERE id = ?").get(activeEntry.entryId).state, 'trashed')
    assert.equal(existsSync(join(x.root, '.trash', 'ws', activeEntry.entryId, '未过期.md')), true)
  } finally { x.close() }
})

test('Given 空回收站或已清理条目 When 清理任务再次运行 Then 返回 0 且不抛错（幂等）', () => {
  const x = setup()
  try {
    const entry = x.trashFile('ws', '幂等.md', { now: 100, expiresAt: 100 + 7 * 86400 * 1000 })
    const past = 100 + 7 * 86400 * 1000 + 1

    assert.equal(purgeExpiredTrash(x.db, { filesDir: x.root, now: past }), 1)
    assert.equal(purgeExpiredTrash(x.db, { filesDir: x.root, now: past }), 0, '重复清理应幂等')
    assert.equal(x.db.prepare("SELECT state FROM file_trash_entries WHERE id = ?").get(entry.entryId).state, 'purged')
  } finally { x.close() }
})
