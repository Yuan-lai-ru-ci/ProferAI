/**
 * 开放 API Key 数据层测试
 *
 * 验证 pk_ key 的创建/反查/归属校验/启停/限额/用量累加/删除。
 * 铁律断言：只存 hash 不存明文；跨用户操作被拒。
 *
 * 运行时同 credits-db.test.js：bun 不支持 better-sqlite3，用适配器重定向到 bun:sqlite。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { installBunSqliteMock } from './test-helpers/sqlite-bun-adapter.js'

installBunSqliteMock(mock)

let tempDir
let dbModule

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'proma-apikeys-db-'))
  process.env.JWT_SECRET = 'x'.repeat(64)
  process.env.DB_PATH = join(tempDir, 'test.db')
  process.env.DATA_DIR = tempDir
  dbModule = await import('./db.js')
})

afterAll(() => {
  // 注意：不 close 共享的 db 单例。bun 把多个测试文件跑在同一进程、共用 db.js 缓存模块，
  // 本文件按字母序早于 credits-db.test.js，若在此 close 会导致后续文件跑在已关闭的 db 上。
  // 交给进程退出回收；temp 目录尽力清理（句柄未释放时 Windows 可能 EBUSY，已吞掉）。
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

function makeUser(id) {
  dbModule.db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `${id}@example.com`, 'hash', id, Date.now())
  return id
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

describe('api key 生命周期', () => {
  test('创建返回明文一次，库里只存 hash + 脱敏前缀', () => {
    const { createApiKey, listApiKeys, db } = dbModule
    const uid = makeUser('u-create')
    const { id, plaintext, prefix } = createApiKey({ userId: uid, name: '开发' })

    expect(plaintext.startsWith('pk_')).toBe(true)
    expect(prefix).toContain('...')
    expect(prefix).not.toBe(plaintext) // 前缀是脱敏的

    // 库里没有明文列，只有 hash
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)
    expect(row.key_hash).toBe(sha256(plaintext))
    expect(JSON.stringify(row)).not.toContain(plaintext)

    // 列表返回不含 hash/明文
    const [k] = listApiKeys(uid)
    expect(k.key_hash).toBeUndefined()
    expect(k.request_count).toBe(0)
    expect(k.status).toBe('active')
  })

  test('按 hash 反查命中用户，未知 hash 返回 undefined', () => {
    const { createApiKey, getApiKeyByHash } = dbModule
    const uid = makeUser('u-lookup')
    const { id, plaintext } = createApiKey({ userId: uid, name: 'x' })

    const rec = getApiKeyByHash(sha256(plaintext))
    expect(rec.id).toBe(id)
    expect(rec.user_id).toBe(uid)
    expect(rec.status).toBe('active')
    // better-sqlite3 无命中返 undefined，bun:sqlite 返 null；中间件用 !rec 兼容两者
    expect(getApiKeyByHash(sha256('pk_nonexistent'))).toBeFalsy()
  })

  test('归属校验：跨用户改名/停用/删除全部被拒', () => {
    const { createApiKey, updateApiKey, deleteApiKey, listApiKeys } = dbModule
    const owner = makeUser('u-owner')
    const attacker = makeUser('u-attacker')
    const { id } = createApiKey({ userId: owner, name: 'secret' })

    expect(updateApiKey(id, attacker, { name: 'hacked' })).toBe(false)
    expect(updateApiKey(id, attacker, { status: 'disabled' })).toBe(false)
    expect(deleteApiKey(id, attacker)).toBe(false)
    // owner 的 key 完好且未被改
    expect(listApiKeys(owner)[0].name).toBe('secret')
    expect(listApiKeys(owner)[0].status).toBe('active')
  })

  test('启停 + 改名 + 改限额 生效', () => {
    const { createApiKey, updateApiKey, listApiKeys } = dbModule
    const uid = makeUser('u-update')
    const { id } = createApiKey({ userId: uid, name: 'a' })

    updateApiKey(id, uid, { name: 'b', status: 'disabled', quotaLimit: 5000000 })
    const k = listApiKeys(uid)[0]
    expect(k.name).toBe('b')
    expect(k.status).toBe('disabled')
    expect(k.quota_limit).toBe(5000000)

    // quotaLimit 传 0/null → 转为不限制(null)
    updateApiKey(id, uid, { quotaLimit: 0 })
    expect(listApiKeys(uid)[0].quota_limit).toBeNull()
  })

  test('touchApiKeyUsage 累加 request_count / last_used / quota_used', () => {
    const { createApiKey, touchApiKeyUsage, listApiKeys } = dbModule
    const uid = makeUser('u-touch')
    const { id } = createApiKey({ userId: uid, name: 'x' })

    touchApiKeyUsage(id, 30000)
    touchApiKeyUsage(id, 20000)
    const k = listApiKeys(uid)[0]
    expect(k.request_count).toBe(2)
    expect(k.quota_used).toBe(50000)
    expect(k.last_used_at).toBeGreaterThan(0)
  })

  test('createApiKey 限额：0/负数 归一为 null，正数保留', () => {
    const { createApiKey, listApiKeys } = dbModule
    const uid = makeUser('u-quota')
    createApiKey({ userId: uid, name: 'unlimited', quotaLimit: 0 })
    createApiKey({ userId: uid, name: 'limited', quotaLimit: 1000000 })
    const list = listApiKeys(uid)
    const unlimited = list.find(k => k.name === 'unlimited')
    const limited = list.find(k => k.name === 'limited')
    expect(unlimited.quota_limit).toBeNull()
    expect(limited.quota_limit).toBe(1000000)
  })
})
