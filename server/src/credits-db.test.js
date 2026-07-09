/**
 * 额度数据库运行时测试
 *
 * 验证扣费/退款/实际用量补退/并发扣减/额度不足等核心计费逻辑。
 *
 * 运行时说明：bun 不支持 better-sqlite3（见 sqlite-bun-adapter.js），
 * 这里通过适配器把 better-sqlite3 重定向到 bun:sqlite，让 db.js 里真实的
 * 计费 SQL 跑在真实的内存 SQLite 上 —— 真覆盖，非 stub。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBunSqliteMock } from './test-helpers/sqlite-bun-adapter.js'

// 必须在 import('./db.js') 之前安装适配器
installBunSqliteMock(mock)

let tempDir
let dbModule

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'proma-credits-db-'))
  process.env.JWT_SECRET = 'x'.repeat(64)
  process.env.DB_PATH = join(tempDir, 'test.db')
  process.env.DATA_DIR = tempDir
  process.env.DEFAULT_CREDIT_GRANT = '100'

  dbModule = await import('./db.js')
})

afterAll(() => {
  dbModule?.db?.close()
  // Windows 下文件句柄释放有延迟，加重试避免 EBUSY
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

/** 创建一个带额度行的测试用户，返回 userId。grant 默认 100（覆盖账号类型默认额度）。 */
function makeUser(id, grant = 100) {
  const { db, ensureCreditRow } = dbModule
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `${id}@example.com`, 'hash', id, Date.now())
  ensureCreditRow(id)
  // ensureCreditRow 按账号类型给默认额度，这里统一改写成测试期望的确定值
  db.prepare('UPDATE credits SET balance = ? WHERE user_id = ?').run(grant, id)
  return id
}

describe('credits adjustment', () => {
  test('扣费后可按实际用量补退，lifetime_consumed 不会变成负数', () => {
    const { adjustCreditDeduction, deductCredits, getCredits } = dbModule
    const userId = makeUser('user-credit-adjustment')
    expect(getCredits(userId).balance).toBe(100)

    const txId = deductCredits(userId, 10, { description: '测试扣费', referenceType: 'api_call', referenceId: 'req-1' })
    expect(getCredits(userId).balance).toBe(90)
    expect(getCredits(userId).lifetime_consumed).toBe(10)

    adjustCreditDeduction(userId, 10, 4, txId)
    expect(getCredits(userId).balance).toBe(96)
    expect(getCredits(userId).lifetime_consumed).toBe(4)

    adjustCreditDeduction(userId, 4, 20, txId)
    expect(getCredits(userId).balance).toBe(80)
    expect(getCredits(userId).lifetime_consumed).toBe(20)

    adjustCreditDeduction(userId, 20, 0, txId)
    expect(getCredits(userId).balance).toBe(100)
    expect(getCredits(userId).lifetime_consumed).toBe(0)
  })
})

// __APPEND_MARKER__

describe('deductCredits 额度不足', () => {
  test('余额不足时抛 INSUFFICIENT_CREDITS:<balance>，且不改动余额', () => {
    const { deductCredits, getCredits } = dbModule
    const userId = makeUser('user-insufficient', 5)

    expect(() => deductCredits(userId, 10, { description: '超额扣费' })).toThrow(/INSUFFICIENT_CREDITS:5/)
    // 失败的扣费不应改动任何状态
    expect(getCredits(userId).balance).toBe(5)
    expect(getCredits(userId).lifetime_consumed).toBe(0)
  })

  test('恰好扣完余额（balance === amount）允许通过', () => {
    const { deductCredits, getCredits } = dbModule
    const userId = makeUser('user-exact', 30)
    deductCredits(userId, 30, { description: '扣完' })
    expect(getCredits(userId).balance).toBe(0)
  })
})

describe('refundCredits 退款', () => {
  test('退款回补余额并减少 lifetime_consumed（不为负）', () => {
    const { deductCredits, refundCredits, getCredits } = dbModule
    const userId = makeUser('user-refund', 100)

    deductCredits(userId, 40, { description: '扣费', referenceId: 'req-refund' })
    expect(getCredits(userId).balance).toBe(60)
    expect(getCredits(userId).lifetime_consumed).toBe(40)

    refundCredits(userId, 40, { description: '上游失败退款', referenceId: 'req-refund' })
    expect(getCredits(userId).balance).toBe(100)
    expect(getCredits(userId).lifetime_consumed).toBe(0)
  })

  test('退款额超过已消耗时 lifetime_consumed 被钳到 0', () => {
    const { refundCredits, getCredits } = dbModule
    const userId = makeUser('user-refund-clamp', 50)
    // 未扣费直接退（异常场景），lifetime_consumed 已是 0，不应变负
    refundCredits(userId, 20, { description: '异常退款', referenceId: 'x' })
    expect(getCredits(userId).balance).toBe(70)
    expect(getCredits(userId).lifetime_consumed).toBe(0)
  })
})

describe('并发扣减不超扣', () => {
  test('并发发起多笔扣费，成功笔数受余额约束，余额不为负', async () => {
    const { deductCredits, getCredits } = dbModule
    const userId = makeUser('user-concurrent', 100)

    // 并发 15 笔各 10 credits（共需 150），余额仅 100 → 至多成功 10 笔
    const attempts = Array.from({ length: 15 }, (_, i) =>
      Promise.resolve().then(() =>
        deductCredits(userId, 10, { description: '并发扣费', referenceId: `c-${i}` }),
      ),
    )
    const results = await Promise.allSettled(attempts)
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.filter((r) => r.status === 'rejected').length

    expect(ok).toBe(10)
    expect(failed).toBe(5)
    const credits = getCredits(userId)
    expect(credits.balance).toBe(0)
    expect(credits.balance).toBeGreaterThanOrEqual(0)
    expect(credits.lifetime_consumed).toBe(100)
  })
})

describe('grantCredits 充值', () => {
  test('管理员充值增加余额并写入 grant 流水', () => {
    const { grantCredits, getCredits, getCreditTransactions } = dbModule
    const admin = makeUser('admin-granter', 0)
    const target = makeUser('user-grant-target', 10)

    grantCredits(admin, target, 500, '管理员手动充值')
    expect(getCredits(target).balance).toBe(510)

    const { transactions } = getCreditTransactions({ userId: target, type: 'grant' })
    const grant = transactions.find((t) => t.amount === 500)
    expect(grant).toBeDefined()
    expect(grant.reference_type).toBe('admin_grant')
  })
})

describe('relay 令牌', () => {
  test('ensureRelayToken 幂等，rotate 后旧令牌失效', () => {
    const { ensureRelayToken, rotateRelayToken, getUserByRelayToken } = dbModule
    const userId = makeUser('user-relay', 0)

    const t1 = ensureRelayToken(userId)
    expect(t1).toMatch(/^prelay_/)
    expect(ensureRelayToken(userId)).toBe(t1) // 幂等

    expect(getUserByRelayToken(t1)?.id).toBe(userId)

    const t2 = rotateRelayToken(userId)
    expect(t2).not.toBe(t1)
    // 旧令牌失效：better-sqlite3 返回 undefined，bun:sqlite 返回 null，统一用 falsy
    expect(getUserByRelayToken(t1)).toBeFalsy()
    expect(getUserByRelayToken(t2)?.id).toBe(userId)
  })
})


// reserveSyncSeq —— 替代原 SELECT MAX(seq) 全表扫描的同步序列号计数器。
// 放在本文件复用其 db 生命周期（beforeAll 打开、afterAll 关闭），断言全部用相对关系，不假设起始值。
describe('reserveSyncSeq (sync 序列号)', () => {
  test('相邻单个预留严格 +1 递增', () => {
    const { reserveSyncSeq } = dbModule
    const a = reserveSyncSeq(1)
    const b = reserveSyncSeq(1)
    expect(b).toBe(a + 1)
  })

  test('批量预留返回该段第一个值且不与后续重叠', () => {
    const { reserveSyncSeq } = dbModule
    const blockStart = reserveSyncSeq(3) // 占用 blockStart, +1, +2
    const next = reserveSyncSeq(1)
    expect(next).toBe(blockStart + 3)
  })

  test('count<1 时按 1 处理（仍前进一格）', () => {
    const { reserveSyncSeq } = dbModule
    const a = reserveSyncSeq(0)
    const b = reserveSyncSeq(1)
    expect(b).toBe(a + 1)
  })

  test('分配的 seq 写入 sync_envelopes 后严格单调递增', () => {
    const { reserveSyncSeq, db } = dbModule
    const uid = makeUser(`user-syncseq-${Date.now()}`)
    const wid = `w-syncseq-${Date.now()}`
    db.prepare('INSERT OR IGNORE INTO workspaces (id,name,slug,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(wid, 't', `${wid}-slug`, uid, Date.now(), Date.now())
    const s1 = reserveSyncSeq(1)
    const s2 = reserveSyncSeq(1)
    const ins = db.prepare(
      'INSERT INTO sync_envelopes (id,workspace_id,entity_type,entity_id,operation,payload,occurred_at,seq) VALUES (?,?,?,?,?,?,?,?)'
    )
    ins.run(`e1-${wid}`, wid, 'file', 'p1', 'update', '{}', Date.now(), s1)
    ins.run(`e2-${wid}`, wid, 'file', 'p2', 'update', '{}', Date.now(), s2)
    expect(s2).toBe(s1 + 1)
    const rows = db.prepare('SELECT seq FROM sync_envelopes WHERE workspace_id = ? ORDER BY seq ASC').all(wid)
    const seqs = rows.map((r) => r.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})
