/**
 * SSE 事件路由
 *
 * GET /v1/workspaces/:id/events — 订阅工作区的实时事件流
 *
 * 客户端通过 SSE 连接后，可接收文件变更、成员变动、邀请状态等事件推送。
 * 30s 心跳保活，客户端断开自动清理。
 */

import { Hono } from 'hono'
import { authMiddleware } from '../middleware.js'
import { registerClient, unregisterClient } from '../event-bus.js'

export const eventRoutes = new Hono()

function requireWorkspaceMember(c, wsId) {
  const { db } = require('../db.js')
  const userId = c.get('userId')
  const member = db.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).get(wsId, userId)
  if (!member) return c.json({ error: '不是工作区成员' }, 403)
  c.set('memberRole', member.role)
}

eventRoutes.get('/:id/events', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw

  const wsId = c.req.param('id')
  const denied = requireWorkspaceMember(c, wsId)
  if (denied) return denied

  // 使用 Hono stream 保持长连接
  return c.stream((stream) => {
    // 注册客户端
    registerClient(wsId, stream)

    // 发送初始连接确认
    stream.write(`event: connected\ndata: ${JSON.stringify({ workspaceId: wsId, serverTime: Date.now() })}\n\n`)

    // 30s heartbeat 保活
    const heartbeat = setInterval(() => {
      try {
        stream.write(': heartbeat\n\n')
      } catch {
        clearInterval(heartbeat)
        unregisterClient(wsId, stream)
      }
    }, 30000)

    // 客户端断开时清理
    stream.onAbort(() => {
      clearInterval(heartbeat)
      unregisterClient(wsId, stream)
    })
  })
})
