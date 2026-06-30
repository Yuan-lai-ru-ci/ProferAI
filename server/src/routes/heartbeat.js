import { Hono } from 'hono'
import { db } from '../db.js'
import { authMiddleware } from '../middleware.js'

export const heartbeatRoutes = new Hono()

heartbeatRoutes.post('/', async (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const userId = c.get('userId')
  const body = (await c.req.json().catch(() => ({}))) || {}
  const workspaceIds = body.workspaceIds
  const now = Date.now()

  if (Array.isArray(workspaceIds) && workspaceIds.length > 0) {
    // 客户端指定了工作区列表：只更新用户实际所属的工作区（防止伪造）
    const memberOf = db.prepare(
      'SELECT workspace_id FROM workspace_members WHERE user_id = ?'
    ).all(userId).map(r => r.workspace_id)
    const validIds = workspaceIds.filter(id => memberOf.includes(id))

    if (validIds.length > 0) {
      const stmt = db.prepare(
        'UPDATE workspace_members SET last_seen_at = ? WHERE workspace_id = ? AND user_id = ?'
      )
      const tx = db.transaction((ids) => {
        for (const wsId of ids) {
          stmt.run(now, wsId, userId)
        }
      })
      tx(validIds)
    }
  } else {
    // 未指定或为空：更新该用户所有工作区的心跳
    db.prepare(
      'UPDATE workspace_members SET last_seen_at = ? WHERE user_id = ?'
    ).run(now, userId)
  }

  return c.json({ success: true, serverTime: now })
})
