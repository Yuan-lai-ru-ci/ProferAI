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

  const insert = db.prepare(
    'INSERT OR REPLACE INTO sync_envelopes (id, workspace_id, entity_type, entity_id, operation, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )

  const tx = db.transaction((items) => {
    for (const env of items) {
      const wsId = env.workspaceId || env.workspace_id
      if (!wsId) continue
      insert.run(env.id, wsId, env.entityType, env.entityId, env.operation, JSON.stringify(env.payload), env.occurredAt)
    }
  })

  tx(envelopes)
  return c.json({ received: envelopes.length })
})

/** 拉取变更 */
syncRoutes.post('/pull', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const body = (await c.req.json().catch(() => ({}))) || {}
  const since = parseInt(body.since || c.req.query('since') || '0')

  const wsIds = db.prepare(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
  ).all(userId).map((r) => r.workspace_id)

  if (wsIds.length === 0) return c.json([])

  const placeholders = wsIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM sync_envelopes WHERE workspace_id IN (${placeholders}) AND occurred_at > ? ORDER BY occurred_at ASC`
  ).all(...wsIds, since)

  return c.json(rows.map((r) => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    operation: r.operation,
    payload: JSON.parse(r.payload),
    occurredAt: r.occurred_at,
  })))
})
