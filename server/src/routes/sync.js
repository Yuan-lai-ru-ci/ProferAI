import { Hono } from 'hono'
import { db, reserveSyncSeq } from '../db.js'
import { authMiddleware } from '../middleware.js'

export const syncRoutes = new Hono()

// 推送与拉取的防护上限，避免单请求 body/结果集过大导致内存飙升
const MAX_PUSH_ENVELOPES = 5000        // 单次 push 最多信封数
const MAX_ENVELOPE_PAYLOAD_BYTES = 256 * 1024 // 单个信封 payload 上限 256KB
const PULL_PAGE_SIZE = 5000            // 单次 pull 最多返回的信封数（分页）

/** 推送变更 */
syncRoutes.post('/push', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const { envelopes } = (await c.req.json()) || {}
  if (!Array.isArray(envelopes)) return c.json({ error: 'envelopes 必填' }, 400)

  // 防护：限制单次推送的信封数量，拒绝超大批量
  if (envelopes.length > MAX_PUSH_ENVELOPES) {
    return c.json({ error: `单次推送信封数超过上限（${MAX_PUSH_ENVELOPES}），请分批推送` }, 413)
  }
  // 防护：拒绝超大 payload（避免恶意/异常客户端撑爆内存与数据库）
  for (const env of envelopes) {
    const size = Buffer.byteLength(JSON.stringify(env?.payload ?? null), 'utf-8')
    if (size > MAX_ENVELOPE_PAYLOAD_BYTES) {
      return c.json({ error: `单个信封 payload 超过上限（${MAX_ENVELOPE_PAYLOAD_BYTES} 字节）` }, 413)
    }
  }

  // 校验用户对每个 envelope 所属工作区的权限
  const userId = c.get('userId')
  const memberOf = db.prepare(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
  ).all(userId).map(r => r.workspace_id)
  const memberSet = new Set(memberOf)

  const tx = db.transaction((items) => {
    const getExisting = db.prepare('SELECT seq FROM sync_envelopes WHERE id = ?')
    const insert = db.prepare(
      'INSERT OR REPLACE INTO sync_envelopes (id, workspace_id, entity_type, entity_id, operation, payload, occurred_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )

    // 先确定每个信封的归属与是否已存在，统计需新分配 seq 的数量
    const decided = []
    let newCount = 0
    for (const env of items) {
      const wsId = env.workspaceId || env.workspace_id
      if (!wsId) continue
      if (!memberSet.has(wsId)) {
        throw new Error(`FORBIDDEN:${wsId}`)
      }
      const existing = getExisting.get(env.id)
      decided.push({ env, wsId, seq: existing ? existing.seq : null })
      if (!existing) newCount++
    }

    // 一次性原子预留 newCount 个连续 seq（替代每条 MAX(seq) 全表扫描）
    let nextSeq = newCount > 0 ? reserveSyncSeq(newCount) : 0
    for (const { env, wsId, seq } of decided) {
      const finalSeq = seq != null ? seq : nextSeq++
      insert.run(env.id, wsId, env.entityType, env.entityId, env.operation, JSON.stringify(env.payload), env.occurredAt, finalSeq)
    }
  })

  try {
    tx(envelopes)
  } catch (err) {
    if (err.message?.startsWith('FORBIDDEN:')) {
      return c.json({ error: `无权向工作区推送变更` }, 403)
    }
    throw err
  }

  return c.json({ received: envelopes.length })
})

/** 拉取变更 */
syncRoutes.post('/pull', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const body = (await c.req.json().catch(() => ({}))) || {}
  const since = parseInt(body.since || c.req.query('since') || '0')
  const afterSeq = parseInt(body.afterSeq || '0')

  const wsIds = db.prepare(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
  ).all(userId).map((r) => r.workspace_id)

  if (wsIds.length === 0) return c.json({ envelopes: [], lastOccurredAt: since, lastSeq: afterSeq })

  const placeholders = wsIds.map(() => '?').join(',')

  // 使用 (occurred_at, seq) 复合游标替代纯时间戳，解决同毫秒并发事件丢数据问题：
  // - 严格 > 改为 (occurred_at > ? OR (occurred_at = ? AND seq > ?))
  // - ORDER BY 加 seq 二级排序保证确定性
  // - LIMIT 分页：避免长时间离线客户端一次拉取百万级行撑爆内存；hasMore 让客户端持续跟进
  const rows = db.prepare(
    `SELECT * FROM sync_envelopes
     WHERE workspace_id IN (${placeholders})
       AND (occurred_at > ? OR (occurred_at = ? AND seq > ?))
     ORDER BY occurred_at ASC, seq ASC
     LIMIT ?`
  ).all(...wsIds, since, since, afterSeq, PULL_PAGE_SIZE)

  const hasMore = rows.length === PULL_PAGE_SIZE

  let lastOccurredAt = since
  let lastSeq = afterSeq

  const envelopes = rows.map((r) => {
    let payload
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = r.payload
    }
    lastOccurredAt = r.occurred_at
    lastSeq = r.seq ?? lastSeq
    return {
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      operation: r.operation,
      payload,
      occurredAt: r.occurred_at,
      seq: r.seq,
    }
  })

  // 返回精确游标，客户端应使用 lastOccurredAt/lastSeq 作为下次请求的 since/afterSeq；
  // hasMore=true 时客户端应立即再拉一页（追赶积压）。
  return c.json({ envelopes, lastOccurredAt, lastSeq, hasMore })
})
