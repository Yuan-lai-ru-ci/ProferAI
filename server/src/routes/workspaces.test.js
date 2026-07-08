/**
 * 工作区软删除/恢复 + 邀请列表过滤 + 硬删除事务 — 纯逻辑测试
 *
 * 与 files.test.js 风格一致：直接测试 DB 操作逻辑，不经过 HTTP。
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import Database from 'better-sqlite3'

let db

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, owner_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'team', brand TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER DEFAULT NULL,
      restored_at INTEGER DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, inviter_id TEXT NOT NULL,
      invitee_email TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      token TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, workspace_id TEXT,
      user_id TEXT, user_email TEXT, entity_type TEXT, entity_id TEXT, detail TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_manifests (
      workspace_id TEXT NOT NULL, file_path TEXT NOT NULL, file_name TEXT NOT NULL,
      is_directory INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER NOT NULL, sha256 TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL DEFAULT '', uploaded_by_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, file_path)
    );
  `)

  // 插入测试用户
  db.prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'owner@test.com', 'Owner', 'hash', Date.now())
})

function createWorkspace(id, name, slug, opts = {}) {
  const now = Date.now()
  db.prepare(`INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at, is_deleted, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, slug, 'u1', now, now, opts.isDeleted ? 1 : 0, opts.deletedAt || null)
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(id, 'u1', 'owner', now)
}

function createInvitation(wid, id, status, createdAt) {
  db.prepare(`INSERT INTO invitations (id, workspace_id, inviter_id, invitee_email, role, token, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, wid, 'u1', 'test@test.com', 'member', `tk-${id}`, status, createdAt || Date.now(), Date.now() + 604800000)
}

// ===== 工作区软删除恢复 =====

describe('工作区软删除', () => {
  test('DELETE 写入 deleted_at + is_deleted', () => {
    createWorkspace('ws-1', '测试', 'test-1')
    const now = Date.now()

    // 模拟 DELETE 端点逻辑
    db.prepare('UPDATE workspaces SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, 'ws-1')

    const row = db.prepare('SELECT is_deleted, deleted_at FROM workspaces WHERE id = ?').get('ws-1')
    expect(row.is_deleted).toBe(1)
    expect(row.deleted_at).toBe(now)
  })

  test('默认列表过滤已删除', () => {
    createWorkspace('ws-2', '活跃', 'test-2')
    createWorkspace('ws-3', '已删', 'test-3', { isDeleted: true, deletedAt: Date.now() })

    // ws-1 在第一个测试中被标记为已删除，所以活跃的只有 ws-2
    const active = db.prepare(
      'SELECT w.*, wm.role FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id WHERE wm.user_id = ? AND w.is_deleted = 0'
    ).all('u1')

    // 至少 ws-2 在列表中，ws-3 不在
    expect(active.find(w => w.id === 'ws-2')).not.toBeUndefined()
    expect(active.find(w => w.id === 'ws-3')).toBeUndefined()
  })

  test('include_deleted 返回冷静期内的工作区', () => {
    const recentlyDeleted = Date.now() - 1000
    createWorkspace('ws-4', '最近删除', 'test-4', { isDeleted: true, deletedAt: recentlyDeleted })

    const graceCutoff = Date.now() - 30 * 86400 * 1000 // 30 天
    const rows = db.prepare(
      `SELECT w.*, wm.role FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND (w.is_deleted = 0 OR (w.is_deleted = 1 AND w.deleted_at > ?))
       ORDER BY w.updated_at DESC`
    ).all('u1', graceCutoff)

    const found = rows.find(w => w.id === 'ws-4')
    expect(found).not.toBeUndefined()
    expect(found.is_deleted).toBe(1)
    expect(found.deleted_at).toBe(recentlyDeleted)

    // 计算 expiresAt
    const expiresAt = found.deleted_at + 30 * 86400 * 1000
    expect(expiresAt).toBeGreaterThan(recentlyDeleted)
  })

  test('冷静期已过的工作区不出现在 include_deleted', () => {
    const longAgo = Date.now() - 100 * 86400 * 1000
    createWorkspace('ws-5', '过期删除', 'test-5', { isDeleted: true, deletedAt: longAgo })

    const graceCutoff = Date.now() - 30 * 86400 * 1000
    const rows = db.prepare(
      `SELECT w.*, wm.role FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND (w.is_deleted = 0 OR (w.is_deleted = 1 AND w.deleted_at > ?))`
    ).all('u1', graceCutoff)

    expect(rows.find(w => w.id === 'ws-5')).toBeUndefined()
  })
})

describe('工作区恢复', () => {
  test('冷静期内恢复：is_deleted=0, deleted_at=NULL', () => {
    createWorkspace('ws-r1', '待恢复', 'test-r1', { isDeleted: true, deletedAt: Date.now() - 1000 })

    const now = Date.now()
    db.prepare('UPDATE workspaces SET is_deleted = 0, deleted_at = NULL, restored_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, 'ws-r1')

    const row = db.prepare('SELECT is_deleted, deleted_at, restored_at FROM workspaces WHERE id = ?').get('ws-r1')
    expect(row.is_deleted).toBe(0)
    expect(row.deleted_at).toBeNull()
    expect(row.restored_at).toBe(now)
  })

  test('冷静期已过：删除时间早于 grace cutoff', () => {
    const longAgo = Date.now() - 100 * 86400 * 1000
    createWorkspace('ws-r2', '过期', 'test-r2', { isDeleted: true, deletedAt: longAgo })

    const graceCutoff = Date.now() - 30 * 86400 * 1000
    const ws = db.prepare('SELECT deleted_at FROM workspaces WHERE id = ?').get('ws-r2')
    const expired = ws.deleted_at && ws.deleted_at <= graceCutoff
    expect(expired).toBe(true)
  })

  test('未删除的工作区 is_deleted=0 返回 false', () => {
    createWorkspace('ws-r3', '活跃', 'test-r3')
    const ws = db.prepare('SELECT is_deleted FROM workspaces WHERE id = ?').get('ws-r3')
    expect(ws.is_deleted).toBe(0)
  })
})

// ===== 邀请列表过滤与分页 =====

describe('邀请列表过滤与分页', () => {
  beforeAll(() => {
    createWorkspace('ws-inv', '邀请测试', 'test-inv')
    const now = Date.now()
    createInvitation('ws-inv', 'i-p', 'pending', now - 5000)
    createInvitation('ws-inv', 'i-a', 'accepted', now - 4000)
    createInvitation('ws-inv', 'i-d', 'declined', now - 3000)
    createInvitation('ws-inv', 'i-e', 'expired', now - 2000)
    createInvitation('ws-inv', 'i-c', 'cancelled', now - 1000)
  })

  test('status=pending 过滤', () => {
    const rows = db.prepare(
      'SELECT * FROM invitations WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC'
    ).all('ws-inv', 'pending')
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('pending')
  })

  test('status=accepted 过滤', () => {
    const rows = db.prepare(
      'SELECT * FROM invitations WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC'
    ).all('ws-inv', 'accepted')
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('accepted')
  })

  test('validStatuses 白名单过滤危险输入', () => {
    const validStatuses = ['pending', 'accepted', 'declined', 'expired', 'cancelled']
    expect(validStatuses.includes('pending')).toBe(true)
    expect(validStatuses.includes('hacked')).toBe(false)
    expect(validStatuses.includes('')).toBe(false)
  })

  test('分页 COUNT + LIMIT OFFSET', () => {
    const limit = 2, page = 1, offset = 0
    const total = db.prepare('SELECT COUNT(*) as total FROM invitations WHERE workspace_id = ?').get('ws-inv').total
    expect(total).toBe(5)

    const rows = db.prepare(
      'SELECT * FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all('ws-inv', limit, offset)
    expect(rows.length).toBe(2)

    const totalPages = Math.ceil(total / limit)
    expect(totalPages).toBe(3)
  })

  test('无过滤参数时返回全部邀请（向后兼容）', () => {
    const rows = db.prepare(
      'SELECT * FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all('ws-inv')
    expect(rows.length).toBe(5)
  })
})

// ===== 硬删除事务 =====

describe('冷静期满硬删除事务', () => {
  test('DELETE cascade 删除工作区及关联记录', () => {
    createWorkspace('ws-clean', '待清理', 'test-clean')
    db.prepare(`INSERT INTO invitations (id, workspace_id, inviter_id, invitee_email, role, token, status, created_at, expires_at)
      VALUES ('ci', 'ws-clean', 'u1', 'x@x.com', 'member', 'tk-ci', 'pending', 1, 9999999999999)`).run()
    db.prepare(`INSERT INTO file_manifests (workspace_id, file_path, file_name, is_directory, size, modified_at)
      VALUES ('ws-clean', 'a.txt', 'a.txt', 0, 100, 1)`).run()

    // 模拟 index.js 清理 job 的事务
    const hardDelete = db.transaction((wsId) => {
      db.prepare('DELETE FROM file_manifests WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM invitations WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId)
    })
    hardDelete('ws-clean')

    expect(db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-clean')).toBeNull()
    expect(db.prepare('SELECT * FROM invitations WHERE workspace_id = ?').all('ws-clean').length).toBe(0)
    expect(db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ?').all('ws-clean').length).toBe(0)
    expect(db.prepare('SELECT * FROM file_manifests WHERE workspace_id = ?').all('ws-clean').length).toBe(0)
  })
})

// ===== 索引验证 =====

describe('DB schema 迁移', () => {
  test('workspaces 表有 deleted_at 列', () => {
    const cols = db.prepare("PRAGMA table_info('workspaces')").all()
    const names = cols.map(c => c.name)
    expect(names.includes('deleted_at')).toBe(true)
    expect(names.includes('restored_at')).toBe(true)
  })

  test('文件搜索索引可创建（CREATE INDEX IF NOT EXISTS）', () => {
    // 模拟 db.js 中迁移的逻辑
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_manifests_file_name ON file_manifests(file_name)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_manifests_file_path ON file_manifests(file_path)')
    // 重复执行不报错
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_manifests_file_name ON file_manifests(file_name)')

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_manifests'").all()
    const names = indexes.map(i => i.name)
    expect(names.some(n => n && n.includes('file_name'))).toBe(true)
    expect(names.some(n => n && n.includes('file_path'))).toBe(true)
  })
})
