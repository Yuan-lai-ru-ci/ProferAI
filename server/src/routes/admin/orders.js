/**
 * Admin 订单管理路由
 *
 * 手动充值期：管理员确认收款 → 订单 pending→paid → 自动加积分/设 VIP
 *
 * 🔒 安全加固：
 *   - 单笔金额上限 MAX_ORDER_AMOUNT_RMB（默认 ¥1000）
 *   - 超过 ORDER_DUAL_CONFIRM_THRESHOLD（默认 ¥500）需另一管理员确认
 *   - 同一管理员每日确认总额上限 ORDER_DAILY_CONFIRM_CAP（默认 ¥1000）
 *   - 记录 created_by 用于双人确认校验
 */
import { Hono } from 'hono'
import { createOrder, confirmOrder, expireOrder, listOrders, getOrder, db } from '../../db.js'
import { logAudit } from '../../audit.js'
import { MAX_ORDER_AMOUNT_RMB, ORDER_DUAL_CONFIRM_THRESHOLD, ORDER_DAILY_CONFIRM_CAP } from '../../config.js'
import { adminOpLimit, ADMIN_OP_LIMITS } from '../../admin-rate-limiter.js'

export const adminOrders = new Hono()

// GET /v1/admin/orders — 订单列表（分页、按状态筛选）
adminOrders.get('/', (c) => {
  const status = c.req.query('status') || undefined
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
  const result = listOrders({ status, page, limit })
  return c.json(result)
})

// GET /v1/admin/orders/:id — 订单详情
adminOrders.get('/:id', (c) => {
  const order = getOrder(c.req.param('id'))
  if (!order) return c.json({ error: '订单不存在' }, 404)
  return c.json(order)
})

// POST /v1/admin/orders — 管理员手动创建充值/套餐/VIP订单
adminOrders.post('/', async (c) => {
  const body = await c.req.json()
  const { userId, type, plan, cycle, amountRmb, remark } = body || {}
  const adminUserId = c.get('userId')

  if (!userId || !type || !amountRmb || amountRmb <= 0) {
    return c.json({ error: 'userId、type、amountRmb(>0) 必填' }, 400)
  }
  if (!['subscription', 'topup', 'vip'].includes(type)) {
    return c.json({ error: 'type 必须是 subscription / topup / vip' }, 400)
  }
  if (type === 'subscription') {
    if (!plan) return c.json({ error: 'subscription 订单必须指定 plan (standard/plus/pro)' }, 400)
    if (!['standard', 'plus', 'pro'].includes(plan)) return c.json({ error: 'plan 必须是 standard / plus / pro' }, 400)
  }

  // 🔒 单笔金额上限
  if (amountRmb > MAX_ORDER_AMOUNT_RMB) {
    return c.json({ error: `单笔订单金额不能超过 ¥${MAX_ORDER_AMOUNT_RMB / 100}` }, 400)
  }

  // 频控
  const freqLimit = adminOpLimit(adminUserId, 'create-order', ADMIN_OP_LIMITS['create-order'])
  if (!freqLimit.allowed) {
    return c.json({ error: '今日创建订单次数已达上限' }, 429)
  }

  // 积分 = 人民币(分) / 10（¥1 = 10 积分）
  const displayPoints = Math.round(amountRmb / 10)

  const result = createOrder({
    userId,
    type,
    plan: plan || null,
    cycle: cycle || 'monthly',
    amountRmb,
    credits: displayPoints,
    remark: remark || '',
    createdBy: adminUserId,
  })

  logAudit({
    action: 'admin.create_order',
    userId: adminUserId,
    userEmail: c.get('userEmail'),
    entityType: 'order',
    entityId: result.id,
    detail: `type=${type} amount_rmb=${amountRmb} points=${displayPoints} for user=${userId}`,
  })

  return c.json({ success: true, orderId: result.id, credits: displayPoints })
})

// POST /v1/admin/orders/:id/confirm — 确认收款
adminOrders.post('/:id/confirm', (c) => {
  const orderId = c.req.param('id')
  const adminUserId = c.get('userId')

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'pending')
  if (!order) return c.json({ error: '订单不存在或已处理' }, 404)

  // 🔒 金额上限二次校验（防止创建后改配置绕过）
  if (order.amount_rmb > MAX_ORDER_AMOUNT_RMB) {
    return c.json({ error: `订单金额超过上限 ¥${MAX_ORDER_AMOUNT_RMB / 100}` }, 400)
  }

  // 🔒 大额订单双人确认
  if (order.amount_rmb >= ORDER_DUAL_CONFIRM_THRESHOLD && order.created_by === adminUserId) {
    return c.json({
      error: `订单金额 ¥${(order.amount_rmb / 100).toFixed(2)} 超过 ¥${ORDER_DUAL_CONFIRM_THRESHOLD / 100} 阈值，需要其他管理员确认`,
      code: 'dual_confirm_required',
    }, 403)
  }

  // 🔒 同一管理员每日确认总额上限
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const dailyTotal = db.prepare(
    'SELECT COALESCE(SUM(amount_rmb), 0) as total FROM orders WHERE confirmed_by = ? AND confirmed_at > ? AND status = ?'
  ).get(adminUserId, todayStart, 'paid').total
  if (dailyTotal + order.amount_rmb > ORDER_DAILY_CONFIRM_CAP) {
    return c.json({ error: `您今日确认订单总额已达上限 ¥${ORDER_DAILY_CONFIRM_CAP / 100}` }, 403)
  }

  // 频控
  const freqLimit = adminOpLimit(adminUserId, 'confirm-order', ADMIN_OP_LIMITS['confirm-order'])
  if (!freqLimit.allowed) {
    return c.json({ error: '今日确认订单次数已达上限' }, 429)
  }

  try {
    confirmOrder(orderId, adminUserId)
  } catch (e) {
    if (e.message === 'ORDER_NOT_FOUND') {
      return c.json({ error: '订单不存在或已处理' }, 404)
    }
    throw e
  }

  logAudit({
    action: 'admin.confirm_order',
    userId: adminUserId,
    userEmail: c.get('userEmail'),
    entityType: 'order',
    entityId: orderId,
    detail: `确认收款 ¥${(order.amount_rmb / 100).toFixed(2)}，${order.created_by === adminUserId ? '单人确认' : '双人确认（创建者=' + (order.created_by || '?') + '）'}`,
  })

  return c.json({ success: true })
})

// POST /v1/admin/orders/:id/expire — 标记过期
adminOrders.post('/:id/expire', (c) => {
  const orderId = c.req.param('id')
  expireOrder(orderId)

  logAudit({
    action: 'admin.expire_order',
    userId: c.get('userId'),
    userEmail: c.get('userEmail'),
    entityType: 'order',
    entityId: orderId,
    detail: '标记过期',
  })

  return c.json({ success: true })
})
