import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureManifestDirectory, upsertManifestEntry } from './manifest-upsert.js'

function createManifestDatabase() {
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
      file_id TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, file_path)
    )
  `)
  return db
}

test('Given 原始上传者的文件 When 管理员覆盖同路径 Then fileId 与创建者保持，更新者变更', () => {
  const db = createManifestDatabase()
  try {
    upsertManifestEntry(db, {
      workspaceId: 'ws-1', path: '资料/方案.md', name: '方案.md', actorId: 'creator', actorName: '创建者',
      size: 10, sha256: 'old', modifiedAt: 100,
    })
    const before = db.prepare('SELECT file_id, created_by, created_at FROM file_manifests').get()

    upsertManifestEntry(db, {
      workspaceId: 'ws-1', path: '资料/方案.md', name: '方案.md', actorId: 'admin', actorName: '管理员',
      size: 20, sha256: 'new', modifiedAt: 200,
    })
    const after = db.prepare('SELECT * FROM file_manifests').get()

    assert.equal(after.file_id, before.file_id)
    assert.equal(after.created_by, 'creator')
    assert.equal(after.created_at, 100)
    assert.equal(after.updated_by, 'admin')
    assert.equal(after.uploaded_by, 'admin')
    assert.equal(after.size, 20)
    assert.equal(after.sha256, 'new')
  } finally {
    db.close()
  }
})

test('Given 同一路径没有旧记录 When 创建目录或文件 Then 生成稳定 fileId 与创建归属', () => {
  const db = createManifestDatabase()
  try {
    upsertManifestEntry(db, {
      workspaceId: 'ws-1', path: '资料', name: '资料', isDirectory: true, actorId: 'user-1', actorName: '用户', modifiedAt: 100,
    })
    const row = db.prepare('SELECT * FROM file_manifests').get()

    assert.match(row.file_id, /^[0-9a-f-]{36}$/)
    assert.equal(row.created_by, 'user-1')
    assert.equal(row.updated_by, 'user-1')
    assert.equal(row.is_directory, 1)
  } finally {
    db.close()
  }
})

test('Given 并发路径已存在的父目录 When 补齐父目录 Then 保留既有 fileId 与创建者', () => {
  const db = createManifestDatabase()
  try {
    upsertManifestEntry(db, {
      workspaceId: 'ws-1', path: '资料', name: '资料', isDirectory: true, actorId: 'creator', actorName: '创建者', modifiedAt: 100,
    })
    const before = db.prepare('SELECT file_id, created_by FROM file_manifests').get()

    ensureManifestDirectory(db, {
      workspaceId: 'ws-1', path: '资料', name: '资料', actorId: 'other-user', actorName: '其他用户', modifiedAt: 200,
    })
    const after = db.prepare('SELECT file_id, created_by, updated_by FROM file_manifests').get()

    assert.equal(after.file_id, before.file_id)
    assert.equal(after.created_by, 'creator')
    assert.equal(after.updated_by, 'creator')
  } finally {
    db.close()
  }
})

test('Given 已有稳定资料身份 When 路径移动或重命名 Then 更新路径不更新 fileId 与创建者', () => {
  const db = createManifestDatabase()
  try {
    upsertManifestEntry(db, {
      workspaceId: 'ws-1', path: '草稿/方案.md', name: '方案.md', actorId: 'creator', actorName: '创建者', modifiedAt: 100,
    })
    const before = db.prepare('SELECT file_id, created_by FROM file_manifests').get()
    db.prepare(`
      UPDATE file_manifests SET file_path = ?, file_name = ?, modified_at = ?
      WHERE workspace_id = ? AND file_path = ?
    `).run('资料/最终方案.md', '最终方案.md', 200, 'ws-1', '草稿/方案.md')
    const after = db.prepare('SELECT file_id, created_by, file_path FROM file_manifests').get()

    assert.equal(after.file_id, before.file_id)
    assert.equal(after.created_by, before.created_by)
    assert.equal(after.file_path, '资料/最终方案.md')
  } finally {
    db.close()
  }
})
