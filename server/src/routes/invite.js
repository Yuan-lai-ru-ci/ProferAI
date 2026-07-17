/**
 * 邀请体系路由 — 邀请码查询、被邀请人列表
 */
import { Hono } from 'hono'
import { getUserInviteCode, getUserInvitees } from '../db.js'

export const inviteRoutes = new Hono()

// GET /v1/account/invite-code — 本人的邀请码和被邀请统计
// 鉴权由 accountApp.use('*', honoAuthMiddleware) 统一处理
inviteRoutes.get('/invite-code', (c) => {
  const userId = c.get('userId')
  const ic = getUserInviteCode(userId)
  const invitees = getUserInvitees(userId)

  return c.json({
    inviteCode: ic?.code || '',
    totalInvites: ic?.total_invites || 0,
    status: ic?.status || 'active',
    invitees: (invitees || []).map((e) => ({
      id: e.id,
      email: e.email,
      displayName: e.display_name,
      event: e.event,
      creditsEarned: e.credits_earned,
      createdAt: e.created_at,
      eventAt: e.event_at,
    })),
  })
})
