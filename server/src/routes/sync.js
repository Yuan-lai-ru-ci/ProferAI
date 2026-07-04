import { Hono } from 'hono'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'

export const syncRoutes = new Hono()

/** 推送变更 */
syncRoutes.post('/push', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const { envelopes } = (await c.req.json()) || {}
  if (!Array.isArray(envelopes)) return c.json({ error: 'envelopes 必填' }, 400)

  // 校验用户对每个 envelope 所属工作区的权限
  const userId = c.get('userId')
  const memberOf = db.prepare(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
  ).all(userId).map(r => r.workspace_id)
  const memberSet = new Set(memberOf)

  const tx = db.transaction((items) => {
    // 在事务内获取当前最大 seq，保证单调递增无间隙
    const maxSeqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM sync_envelopes').get()
    let nextSeq = (maxSeqRow?.maxSeq ?? 0) + 1

    for (const env of items) {
      const wsId = env.workspaceId || env.workspace_id
      if (!wsId) continue
      if (!memberSet.has(wsId)) {
        throw new Error(`FORBIDDEN:${wsId}`)
      }

      // INSERT OR REPLACE：已存在的信封保留原 seq，新信封分配递增值
      const existing = db.prepare('SELECT seq FROM sync_envelopes WHERE id = ?').get(env.id)
      const seq = existing ? existing.seq : nextSeq++

      db.prepare(
        'INSERT OR REPLACE INTO sync_envelopes (id, workspace_id, entity_type, entity_id, operation, payload, occurred_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(env.id, wsId, env.entityType, env.entityId, env.operation, JSON.stringify(env.payload), env.occurredAt, seq)
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
  const rows = db.prepare(
    `SELECT * FROM sync_envelopes
     WHERE workspace_id IN (${placeholders})
       AND (occurred_at > ? OR (occurred_at = ? AND seq > ?))
     ORDER BY occurred_at ASC, seq ASC`
  ).all(...wsIds, since, since, afterSeq)

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

  // 返回精确游标，客户端应使用 lastOccurredAt/lastSeq 作为下次请求的 since/afterSeq
  return c.json({ envelopes, lastOccurredAt, lastSeq })
})
