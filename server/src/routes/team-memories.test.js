/**
 * 团队共享记忆（team-memories）路由测试
 *
 * 用 mock.module 替换 db.js / middleware.js：注入内存测试库与可控认证，
 * 不触碰生产数据库文件。覆盖 CRUD、版本冲突、成员权限、归档冻结、修订历史。
 */
import { describe, expect, test, beforeAll, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'

// ===== 内存测试库（覆盖路由全部依赖表） =====
const testDb = new Database(':memory:')
testDb.exec(`
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'team', brand TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER DEFAULT NULL, restored_at INTEGER DEFAULT NULL
  );
  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE team_memories (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
    UNIQUE(workspace_id, path)
  );
  CREATE TABLE team_memory_revisions (
    id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    version INTEGER NOT NULL, content_snapshot TEXT NOT NULL,
    change_summary TEXT NOT NULL DEFAULT '', edited_by TEXT NOT NULL, edited_at INTEGER NOT NULL,
    UNIQUE(memory_id, version)
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, workspace_id TEXT,
    user_id TEXT, user_email TEXT, entity_type TEXT, entity_id TEXT, detail TEXT,
    created_at INTEGER NOT NULL, prev_hash TEXT NOT NULL DEFAULT '', row_hash TEXT NOT NULL DEFAULT '', nonce TEXT NOT NULL DEFAULT ''
  );
`)

// ===== 可控认证：Bearer token → 测试用户 =====
const usersByToken = {
  'owner-token': { id: 'u-owner', email: 'owner@test.com' },
  'member-token': { id: 'u-member', email: 'member@test.com' },
  'stranger-token': { id: 'u-stranger', email: 'stranger@test.com' },
}
mock.module('../db.js', () => ({ db: testDb }))
mock.module('../middleware.js', () => ({
  authMiddleware: (c) => {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) return c.json({ error: '未提供认证令牌' }, 401)
    const user = usersByToken[auth.slice(7)]
    if (!user) return c.json({ error: '令牌无效或已过期' }, 401)
    c.set('userId', user.id)
    c.set('userEmail', user.email)
    return null
  },
}))

const { teamMemoryRoutes } = await import('./team-memories.js')
const app = new Hono()
app.route('/', teamMemoryRoutes)

// ===== 种子数据：一个工作区，owner + member =====
testDb.prepare(`INSERT INTO workspaces (id,name,slug,owner_id,created_at,updated_at) VALUES ('w1','测试团队','test-team','u-owner',1,1)`).run()
testDb.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES ('w1','u-owner','owner',1), ('w1','u-member','member',1)`).run()

const base = (token) => ({ headers: { Authorization: `Bearer ${token}` } })
const json = (token, body, method = 'POST') => ({ method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('认证与成员权限', () => {
  test('未认证请求返回 401', async () => {
    const res = await app.request('/w1/memories')
    expect(res.status).toBe(401)
  })

  test('非成员访问返回 403', async () => {
    const res = await app.request('/w1/memories', base('stranger-token'))
    expect(res.status).toBe(403)
  })

  test('已删除工作区视为无权访问', async () => {
    testDb.prepare(`INSERT INTO workspaces (id,name,slug,owner_id,created_at,updated_at,is_deleted) VALUES ('w-del','已删','del','u-owner',1,1,1)`).run()
    testDb.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,joined_at) VALUES ('w-del','u-owner','owner',1)`).run()
    const res = await app.request('/w-del/memories', base('owner-token'))
    expect(res.status).toBe(403)
  })
})

describe('创建团队记忆', () => {
  test('owner 创建成功：201、version=1、生成修订记录', async () => {
    const res = await app.request('/w1/memories', json('owner-token', { path: '规范/编码约定.md', title: '编码约定', content: '使用 2 空格缩进', changeSummary: '初始创建' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.version).toBe(1)
    expect(body.createdBy).toBe('u-owner')
    expect(body.archivedAt).toBeUndefined()

    const rev = testDb.prepare('SELECT COUNT(*) c FROM team_memory_revisions WHERE memory_id = ?').get(body.id)
    expect(rev.c).toBe(1)
  })

  test('普通成员也可以创建', async () => {
    const res = await app.request('/w1/memories', json('member-token', { path: '会议/周会.md', title: '周会', content: '周会纪要' }))
    expect(res.status).toBe(201)
  })

  test('重复路径返回 409', async () => {
    const res = await app.request('/w1/memories', json('owner-token', { path: '规范/编码约定.md', title: '重复', content: 'x' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: '团队记忆路径已存在' })
  })

  test('参数非法返回 400：缺标题 / 路径穿越 / 超长内容', async () => {
    expect((await app.request('/w1/memories', json('owner-token', { path: 'a.md', content: 'x' }))).status).toBe(400)
    expect((await app.request('/w1/memories', json('owner-token', { path: '../secret.md', title: 'x', content: 'x' }))).status).toBe(400)
    expect((await app.request('/w1/memories', json('owner-token', { path: '/绝对路径.md', title: 'x', content: 'x' }))).status).toBe(400)
    expect((await app.request('/w1/memories', json('owner-token', { path: 'a.md', title: 'x', content: 'x'.repeat(1024 * 1024 + 1) }))).status).toBe(400)
  })
})

describe('读取团队记忆', () => {
  test('列表默认不含归档，includeArchived=true 返回全部', async () => {
    testDb.prepare(`INSERT INTO team_memories (id,workspace_id,path,title,content,version,created_by,updated_by,created_at,updated_at,archived_at) VALUES ('m-arch','w1','归档/x.md','已归档','c',1,'u-owner','u-owner',1,1,1)`).run()
    const list = await (await app.request('/w1/memories', base('owner-token'))).json()
    expect(list.some((m) => m.id === 'm-arch')).toBe(false)
    const withArchived = await (await app.request('/w1/memories?includeArchived=true', base('owner-token'))).json()
    expect(withArchived.some((m) => m.id === 'm-arch')).toBe(true)
  })

  test('列表返回摘要（不含 content），按 updated_at 倒序', async () => {
    const list = await (await app.request('/w1/memories', base('owner-token'))).json()
    expect(list.length).toBeGreaterThan(0)
    expect(list[0].content).toBeUndefined()
    const times = list.map((m) => m.updatedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  test('获取单条返回完整 dto；不存在返回 404', async () => {
    const rows = testDb.prepare("SELECT id FROM team_memories WHERE path = '规范/编码约定.md'").get()
    const res = await app.request(`/w1/memories/${rows.id}`, base('owner-token'))
    expect(res.status).toBe(200)
    expect((await res.json()).content).toBe('使用 2 空格缩进')
    expect((await app.request('/w1/memories/not-exist', base('owner-token'))).status).toBe(404)
  })
})

describe('更新与版本冲突', () => {
  let memoryId
  beforeAll(async () => {
    const res = await app.request('/w1/memories', json('owner-token', { path: '冲突/文档.md', title: '冲突文档', content: 'v1' }))
    memoryId = (await res.json()).id
  })

  test('expectedVersion 匹配则更新成功：version+1 且生成修订', async () => {
    const res = await app.request(`/w1/memories/${memoryId}`, json('member-token', { expectedVersion: 1, content: 'v2', changeSummary: '修订' }, 'PATCH'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe(2)
    expect(body.updatedBy).toBe('u-member')
    const rev = testDb.prepare('SELECT version, content_snapshot, edited_by FROM team_memory_revisions WHERE memory_id = ? ORDER BY version DESC').all(memoryId)[0]
    expect(rev.version).toBe(2)
    expect(rev.content_snapshot).toBe('v2')
    expect(rev.edited_by).toBe('u-member')
  })

  test('expectedVersion 不匹配返回 409 + TEAM_MEMORY_VERSION_CONFLICT + current', async () => {
    const res = await app.request(`/w1/memories/${memoryId}`, json('owner-token', { expectedVersion: 1, content: 'stale' }, 'PATCH'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('TEAM_MEMORY_VERSION_CONFLICT')
    expect(body.current.version).toBe(2)
  })

  test('缺少 expectedVersion 返回 400', async () => {
    const res = await app.request(`/w1/memories/${memoryId}`, json('owner-token', { content: 'x' }, 'PATCH'))
    expect(res.status).toBe(400)
  })

  test('归档后的记忆拒绝编辑（治理冻结）', async () => {
    testDb.prepare(`INSERT INTO team_memories (id,workspace_id,path,title,content,version,created_by,updated_by,created_at,updated_at,archived_at) VALUES ('m-frozen','w1','归档/冻结.md','冻结','c',3,'u-owner','u-owner',1,1,99)`).run()
    const res = await app.request('/w1/memories/m-frozen', json('member-token', { expectedVersion: 3, content: 'x' }, 'PATCH'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: '团队记忆已归档，请联系管理员恢复后再编辑' })
  })
})

describe('归档与恢复（仅管理员）', () => {
  let memoryId
  beforeAll(async () => {
    const res = await app.request('/w1/memories', json('owner-token', { path: '治理/归档目标.md', title: '归档目标', content: 'c' }))
    memoryId = (await res.json()).id
  })

  test('普通成员归档返回 403', async () => {
    expect((await app.request(`/w1/memories/${memoryId}/archive`, { method: 'POST', ...base('member-token') })).status).toBe(403)
  })

  test('owner 归档成功：archived_at 生效', async () => {
    const res = await app.request(`/w1/memories/${memoryId}/archive`, { method: 'POST', ...base('owner-token') })
    expect(res.status).toBe(200)
    expect((await res.json()).archivedAt).toBeGreaterThan(0)
  })

  test('owner 取消归档恢复可编辑', async () => {
    const res = await app.request(`/w1/memories/${memoryId}/unarchive`, { method: 'POST', ...base('owner-token') })
    expect(res.status).toBe(200)
    expect((await res.json()).archivedAt).toBeUndefined()
    const edit = await app.request(`/w1/memories/${memoryId}`, json('owner-token', { expectedVersion: 1, content: '恢复后可编辑' }, 'PATCH'))
    expect(edit.status).toBe(200)
  })
})

describe('修订历史', () => {
  test('revisions 按版本倒序返回', async () => {
    const rows = testDb.prepare("SELECT id FROM team_memories WHERE path = '冲突/文档.md'").get()
    const res = await app.request(`/w1/memories/${rows.id}/revisions`, base('owner-token'))
    expect(res.status).toBe(200)
    const revs = await res.json()
    expect(revs.length).toBe(2)
    expect(revs[0].version).toBe(2)
    expect(revs[1].version).toBe(1)
    expect(revs[0].editedBy).toBe('u-member')
  })

  test('不存在的记忆 revisions 返回 404', async () => {
    expect((await app.request('/w1/memories/not-exist/revisions', base('owner-token'))).status).toBe(404)
  })
})
