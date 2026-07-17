/**
 * 订阅/订单/邀请/drip/兑换码 业务逻辑
 *
 * 依赖 schema.js（db 实例）和 credits.js（额度操作）。
 * 所有订阅生命周期、订单确认、返利、drip 操作集中在此模块。
 */
import { db } from './schema.js'
import { ensureCreditRow, syncCreditBalance, pointsToQuota } from './credits.js'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// ===== 套餐定价常量 =====
const NEWAPI_QPU = 500000 // quota per $1 unit

const PLAN_DEFS = {
  standard: { monthlyRmb: 2900, yearlyRmb: 29600, welcomeBonus: 60, dailyDrip: 8 },
  plus:     { monthlyRmb: 4900, yearlyRmb: 50000, welcomeBonus: 200, dailyDrip: 20 },
  pro:      { monthlyRmb: 9900, yearlyRmb: 101000, welcomeBonus: 450, dailyDrip: 40 },
}
const VIP_DISCOUNT = 0.9   // VIP 套餐 9 折
const VIP_EXTRA_DRIP = 20  // VIP 额外每日 drip（积分单位）

// 兑换码用套餐定义（独立常量，避免与购买价格耦合）
const PLAN_DEFS_REDEEM = {
  standard: { monthlyRmb: 2900, yearlyRmb: 29600, welcomeBonus: 60, dailyDrip: 8 },
  plus:     { monthlyRmb: 4900, yearlyRmb: 50000, welcomeBonus: 200, dailyDrip: 20 },
  pro:      { monthlyRmb: 9900, yearlyRmb: 101000, welcomeBonus: 450, dailyDrip: 40 },
}
const VIP_EXTRA_DRIP_REDEEM = 20

// ===== 邀请码 =====

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'U'
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }
  return code
}

/** 为用户创建专属邀请码（一人一码，幂等） */
export function createInviteCode(userId) {
  const existing = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(userId)
  if (existing) return existing.code
  let code, retries = 0
  do {
    code = generateInviteCode()
    retries++
  } while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code) && retries < 10)
  db.prepare('INSERT INTO invite_codes (id, user_id, code, created_at) VALUES (?, ?, ?, ?)')
    .run(uuidv4(), userId, code, Date.now())
  return code
}

/** 按邀请码查找邀请人 */
export function getInviterByCode(code) {
  return db.prepare(`
    SELECT ic.user_id, ic.code, u.email, u.display_name
    FROM invite_codes ic
    JOIN users u ON u.id = ic.user_id
    WHERE ic.code = ? AND ic.status = 'active'
  `).get(code)
}

/** 获取用户的邀请码 */
export function getUserInviteCode(userId) {
  return db.prepare('SELECT * FROM invite_codes WHERE user_id = ?').get(userId)
}

/** 获取用户邀请的人列表 */
export function getUserInvitees(userId) {
  return db.prepare(`
    SELECT u.id, u.email, u.display_name, u.created_at,
           ir.event, ir.credits_earned, ir.created_at as event_at
    FROM invite_records ir
    JOIN users u ON u.id = ir.invitee_id
    WHERE ir.inviter_id = ?
    ORDER BY ir.created_at DESC
  `).all(userId)
}

/** 记录邀请事件 */
export function recordInviteEvent({ inviterId, inviteeId, event, creditsEarned = 0, orderId = null, purchaseIndex = 0 }) {
  db.prepare(`INSERT INTO invite_records (id, inviter_id, invitee_id, event, credits_earned, order_id, purchase_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), inviterId, inviteeId, event, creditsEarned, orderId || null, purchaseIndex, Date.now())
  if (event === 'register') {
    db.prepare('UPDATE invite_codes SET total_invites = total_invites + 1 WHERE user_id = ?')
      .run(inviterId)
  }
}

// ===== 订单管理 =====

/** 创建订单。amountRmb 人民币分，credits 内部换算为 quota 单位存储 */
export function createOrder({ userId, type, plan = null, cycle = 'monthly', amountRmb, credits, remark = '', createdBy = '' }) {
  const id = uuidv4()
  const quotaCredits = (credits || Math.round(amountRmb / 10)) * 50000
  db.prepare(`INSERT INTO orders (id, user_id, type, plan, amount_rmb, credits, status, remark, cycle, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, userId, type, plan, amountRmb, quotaCredits, remark, cycle, createdBy, Date.now())
  return { id, quotaCredits }
}

/** 返利积分单位换算 */
function rewardPointsToQuota(points) {
  return points * 50_000
}

/**
 * 首次（非续费）购买套餐/充值/VIP 时触发邀请返利。
 * 在 confirmOrder 事务内调用，保证原子性。
 */
function rewardReferrerOnPurchase(order) {
  if (order.type === 'subscription') {
    const sub = db.prepare('SELECT renewed_at FROM subscriptions WHERE user_id = ?').get(order.user_id)
    if (sub?.renewed_at) return // 续费不返利
  }

  const user = db.prepare('SELECT invited_by FROM users WHERE id = ?').get(order.user_id)
  if (!user?.invited_by) return

  const inviterId = user.invited_by
  const now = Date.now()

  const purchaseIndex = db.prepare(
    `SELECT COUNT(*) as cnt FROM invite_records WHERE inviter_id = ? AND invitee_id = ? AND event IN ('purchase', 'vip_purchase')`
  ).get(inviterId, order.user_id)?.cnt || 0

  let rewardPoints = 0
  let event = 'purchase'

  if (order.type === 'vip') {
    rewardPoints = 300
    event = 'vip_purchase'
  } else if (purchaseIndex < 3) {
    const orderPoints = Math.round(order.credits / 50_000)
    rewardPoints = Math.round(orderPoints * 0.1)
  }

  if (rewardPoints <= 0) return

  const rewardQuota = rewardPointsToQuota(rewardPoints)

  db.prepare('UPDATE users SET balance_referral = balance_referral + ? WHERE id = ?')
    .run(rewardQuota, inviterId)

  db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
    VALUES (?, ?, ?, 'topup', ?, 'referral', 'invite_reward', ?, ?)`)
    .run(uuidv4(), inviterId, rewardQuota,
      `邀请返利：${event === 'vip_purchase' ? 'VIP购买' : `第${purchaseIndex + 1}次付费`} +${rewardPoints} 积分`,
      order.id, now)

  db.prepare(`INSERT INTO invite_records (id, inviter_id, invitee_id, event, credits_earned, order_id, purchase_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), inviterId, order.user_id, event, rewardQuota, order.id, purchaseIndex + 1, now)

  if (event !== 'vip_purchase') {
    db.prepare('UPDATE invite_codes SET total_invites = total_invites + 1 WHERE user_id = ?')
      .run(inviterId)
  }
}

/** 确认收款：pending → paid，加积分/设 VIP/激活套餐/记流水 */
export function confirmOrder(orderId, adminUserId) {
  const tx = db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = ?').get(orderId, 'pending')
    if (!order) throw new Error('ORDER_NOT_FOUND')

    const now = Date.now()
    db.prepare('UPDATE orders SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?')
      .run('paid', adminUserId, now, orderId)

    switch (order.type) {
      case 'topup':
        db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
          .run(order.credits, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, order.credits,
            `手动充值 ¥${(order.amount_rmb / 100).toFixed(2)} → ${order.credits} 积分`,
            orderId, now)
        break

      case 'vip':
        db.prepare('UPDATE users SET is_vip = 1, multiplier = 0.8 WHERE id = ?')
          .run(order.user_id)
        db.prepare(`UPDATE subscriptions SET daily_drip_rate = daily_drip_rate + ? WHERE user_id = ? AND status = 'active'`)
          .run(VIP_EXTRA_DRIP, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, 0,
            `VIP 终身会员 ¥${(order.amount_rmb / 100).toFixed(2)}`,
            orderId, now)
        break

      case 'subscription': {
        const plan = PLAN_DEFS[order.plan] || PLAN_DEFS.standard
        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(order.user_id)
        const isVip = user?.is_vip || order.plan === 'vip'
        const cycle = order.cycle || 'monthly'

        const baseRmb = cycle === 'yearly' ? plan.yearlyRmb : plan.monthlyRmb
        const actualRmb = isVip ? Math.round(baseRmb * VIP_DISCOUNT) : baseRmb

        const bonusMultiplier = cycle === 'yearly' ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)

        const dripRate = plan.dailyDrip + (isVip ? VIP_EXTRA_DRIP : 0)

        const expiresMs = cycle === 'yearly' ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        const existingSub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(order.user_id)
        if (existingSub) {
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active', welcome_bonus_claimed = 1,
            welcome_bonus_amount = ?, daily_drip_rate = ?, vip_discount_applied = ?,
            started_at = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL, created_at = ? WHERE user_id = ?`)
            .run(order.plan, welcomeBonusQuota, dripRate, isVip ? 1 : 0, now, now + expiresMs, now, now, order.user_id)
        } else {
          db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed, welcome_bonus_amount,
            daily_drip_rate, vip_discount_applied, started_at, expires_at, created_at)
            VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), order.user_id, order.plan, welcomeBonusQuota, dripRate, isVip ? 1 : 0, now, now + expiresMs, now)
        }

        db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?')
          .run(order.plan, order.user_id)

        db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
          .run(welcomeBonusQuota, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'package', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, welcomeBonusQuota,
            `${order.plan}${cycle === 'yearly' ? '年付' : '月付'} 首购红包 ${welcomeBonusPoints} 积分` +
            (isVip ? ` (VIP 9折)` : ''),
            orderId, now)

        syncCreditBalance(order.user_id)
        break
      }
    }

    rewardReferrerOnPurchase(order)
  })
  tx()
}

/** 标记订单过期 */
export function expireOrder(orderId) {
  db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(orderId)
}

/** 订单列表（分页、按状态筛选） */
export function listOrders({ status, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND o.status = ?'; params.push(status) }
  const total = db.prepare(`SELECT COUNT(*) as total FROM orders o ${where}`).get(...params).total
  const rows = db.prepare(`
    SELECT o.*, u.email as user_email, u.display_name as user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)
  return { orders: rows, total, page, limit }
}

/** 获取单个订单 */
export function getOrder(orderId) {
  return db.prepare(`
    SELECT o.*, u.email as user_email, u.display_name as user_name
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `).get(orderId)
}

// ===== 套餐生命周期 =====

/** 获取用户活跃订阅 */
export function getActiveSubscription(userId) {
  return db.prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(userId)
}

/** 获取用户订阅状态（含 drip 信息） */
export function getSubscriptionStatus(userId) {
  const sub = db.prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active', 'frozen') ORDER BY created_at DESC LIMIT 1"
  ).get(userId)
  if (!sub) return null
  const user = db.prepare('SELECT membership_tier, is_vip, multiplier FROM users WHERE id = ?').get(userId)
  return {
    plan: sub.plan,
    cycle: sub.cycle || 'monthly',
    status: sub.status,
    startedAt: sub.started_at,
    expiresAt: sub.expires_at,
    welcomeBonusAmount: sub.welcome_bonus_amount,
    dailyDripRate: sub.daily_drip_rate,
    vipDiscountApplied: !!sub.vip_discount_applied,
    dripAvailableThisWeek: sub.drip_available_this_week || 0,
    dripLastAccrualDate: sub.drip_last_accrual_date || null,
    dripLastClaimedDate: sub.drip_last_claimed_date || null,
    membershipTier: user?.membership_tier || 'free',
    isVip: !!user?.is_vip,
    multiplier: user?.multiplier || 1.0,
  }
}

/** 销毁套餐（不可退订，套餐积分保留到自然消耗） */
export function destroySubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'destroyed', destroyed_at = ? WHERE user_id = ? AND status = 'active'")
    .run(now, userId)
}

/** 冻结套餐（到期未续，套餐积分冻结） */
export function freezeSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'frozen' WHERE user_id = ? AND status = 'active' AND expires_at <= ?")
    .run(userId, now)
}

/** 续费解冻 */
export function unfreezeSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'active', renewed_at = ? WHERE user_id = ? AND status = 'frozen'")
    .run(now, userId)
}

/** 升级套餐：补差价，红包不补，drip 立即提级 */
export function upgradeSubscription(userId, newPlan) {
  const plan = PLAN_DEFS[newPlan]
  if (!plan) throw new Error('INVALID_PLAN')
  const now = Date.now()
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(userId)
  if (!sub) throw new Error('NO_ACTIVE_SUBSCRIPTION')
  if (sub.plan === newPlan) return

  const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
  const dripRate = plan.dailyDrip + (user?.is_vip ? VIP_EXTRA_DRIP : 0)

  db.prepare(`UPDATE subscriptions SET plan = ?, daily_drip_rate = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`)
    .run(newPlan, dripRate, now, userId)
  db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(newPlan, userId)
}

/** 标记到期（由定时任务调用） */
export function expireSubscription(userId) {
  const now = Date.now()
  db.prepare("UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active' AND expires_at <= ?")
    .run(userId, now)
}

// ===== Drip 领取制 =====

/** 每日 drip 累加：将 daily_drip_rate 加入 drip_available_this_week */
export function accrueDailyDrip() {
  const today = new Date().toISOString().slice(0, 10)
  const now = Date.now()
  const tx = db.transaction(() => {
    const subs = db.prepare(
      "SELECT id, user_id, daily_drip_rate, drip_available_this_week, drip_last_accrual_date FROM subscriptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)"
    ).all(now)

    let accrued = 0
    for (const sub of subs) {
      if (sub.drip_last_accrual_date === today) continue
      if (!sub.daily_drip_rate || sub.daily_drip_rate <= 0) continue

      const dripQuota = pointsToQuota(sub.daily_drip_rate)
      db.prepare('UPDATE subscriptions SET drip_available_this_week = drip_available_this_week + ?, drip_last_accrual_date = ? WHERE id = ?')
        .run(dripQuota, today, sub.id)
      accrued++
    }
    return accrued
  })
  return tx()
}

/** 领取本周全部 drip：drip_available_this_week → balance_package */
export function claimDrip(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare(
      "SELECT id, drip_available_this_week, drip_last_claimed_date FROM subscriptions WHERE user_id = ? AND status = 'active'"
    ).get(userId)
    if (!sub || !sub.drip_available_this_week || sub.drip_available_this_week <= 0) return 0

    const amount = sub.drip_available_this_week
    db.prepare('UPDATE subscriptions SET drip_available_this_week = 0, drip_last_claimed_date = ? WHERE id = ?')
      .run(today, sub.id)
    db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
      .run(amount, userId)
    db.prepare('UPDATE credits SET balance = balance + ?, updated_at = ? WHERE user_id = ?')
      .run(amount, now, userId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'drip_claim', ?, 'package', 'drip_claim', ?, ?)`)
      .run(uuidv4(), userId, amount, `领取本周 drip ${Math.round(amount / 50000)} 积分`, sub.id, now)
    return amount
  })
  return tx()
}

/** 跨周清零未领 drip（周日调用） */
export function clearWeeklyDrip() {
  const now = Date.now()
  const tx = db.transaction(() => {
    const subs = db.prepare(
      "SELECT id, user_id, drip_available_this_week FROM subscriptions WHERE status = 'active' AND drip_available_this_week > 0"
    ).all()

    let cleared = 0
    for (const sub of subs) {
      const forfeited = sub.drip_available_this_week
      db.prepare('UPDATE subscriptions SET drip_available_this_week = 0 WHERE id = ?').run(sub.id)
      if (forfeited > 0) {
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'drip_expiry', ?, 'package', 'drip_weekly_clear', ?, ?)`)
          .run(uuidv4(), sub.user_id, 0, `周清零：过期未领 drip ${Math.round(forfeited / 50000)} 积分`, sub.id, now)
      }
      cleared++
    }
    return cleared
  })
  return tx()
}

// ===== 激活码管理 =====

/** 生成激活码 */
export function createActivationCode({ code, createdBy, expiresAt, membershipTier = 'free' }) {
  const id = uuidv4()
  const now = Date.now()
  db.prepare('INSERT INTO activation_codes (id, code, status, created_by, expires_at, account_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, 'pending', createdBy, expiresAt || null, membershipTier, now)
  return { id, code, membershipTier }
}

/** 列出激活码 */
export function listActivationCodes({ status } = {}) {
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND status = ?'; params.push(status) }
  return db.prepare(`SELECT * FROM activation_codes ${where} ORDER BY created_at DESC`).all(...params)
}

/** 验证激活码。有效时返回 { valid:true, membershipTier } */
export function validateActivationCode(code) {
  const row = db.prepare("SELECT * FROM activation_codes WHERE code = ? AND status = 'pending'").get(code)
  if (!row) return { valid: false, error: '激活码无效' }
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("UPDATE activation_codes SET status = 'expired' WHERE id = ?").run(row.id)
    return { valid: false, error: '激活码已过期' }
  }
  return { valid: true, membershipTier: row.account_type || 'free' }
}

/** 使用激活码 */
export function useActivationCode(code, userId) {
  const now = Date.now()
  db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending'")
    .run(userId, now, code)
}

// ===== 兑换码管理 =====

/** 生成兑换码 */
export function createRedemptionCode({ code, type, value, cycle = 'monthly', createdBy, expiresAt }) {
  const id = uuidv4()
  const now = Date.now()
  db.prepare('INSERT INTO redemption_codes (id, code, type, value, cycle, status, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, code, type, value, cycle, 'active', createdBy, expiresAt || null, now)
  return { id, code, type, value, cycle }
}

/** 列出兑换码 */
export function listRedemptionCodes({ status, type } = {}) {
  let where = 'WHERE 1=1'
  const params = []
  if (status) { where += ' AND status = ?'; params.push(status) }
  if (type) { where += ' AND type = ?'; params.push(type) }
  return db.prepare(`SELECT rc.*, u.email as used_by_email FROM redemption_codes rc LEFT JOIN users u ON u.id = rc.used_by ${where} ORDER BY rc.created_at DESC`).all(...params)
}

/** 验证兑换码。有效返回 { valid:true, type, value, cycle } */
export function validateRedemptionCode(code) {
  const row = db.prepare("SELECT * FROM redemption_codes WHERE code = ? AND status = 'active'").get(code)
  if (!row) return { valid: false, error: '兑换码无效' }
  if (row.expires_at && row.expires_at < Date.now()) {
    db.prepare("UPDATE redemption_codes SET status = 'expired' WHERE id = ?").run(row.id)
    return { valid: false, error: '兑换码已过期' }
  }
  return { valid: true, id: row.id, type: row.type, value: row.value, cycle: row.cycle || 'monthly' }
}

/** 标记兑换码已使用 */
export function markRedemptionCodeUsed(codeId, userId) {
  const now = Date.now()
  db.prepare("UPDATE redemption_codes SET status = 'used', used_by = ?, used_at = ? WHERE id = ?")
    .run(userId, now, codeId)
}

/**
 * 执行兑换：根据 type 发放对应权益。
 * - credits: value 为积分数量，写入 balance_purchased
 * - plan: value 为套餐名 (standard/plus/pro)，cycle 为周期，创建/续费订阅
 * - vip: 设置 is_vip = 1，终身 VIP
 */
export function redeemCode(userId, { id: codeId, type, value, cycle }) {
  const now = Date.now()

  const tx = db.transaction(() => {
    const current = db.prepare("SELECT status FROM redemption_codes WHERE id = ?").get(codeId)
    if (current?.status !== 'active') throw new Error('CODE_ALREADY_USED')

    let description = ''

    switch (type) {
      case 'credits': {
        const points = parseInt(value, 10) || 0
        if (points <= 0) throw new Error('INVALID_CREDITS_VALUE')
        const quota = pointsToQuota(points)
        db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
          .run(quota, userId)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, quota, `兑换码兑换 ${points} 积分`, codeId, now)
        syncCreditBalance(userId)
        description = `兑换 ${points} 积分`
        break
      }

      case 'plan': {
        const plan = PLAN_DEFS_REDEEM[value]
        if (!plan) throw new Error('INVALID_PLAN')
        const isYearly = cycle === 'yearly'
        const bonusMultiplier = isYearly ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)
        const dripRate = plan.dailyDrip
        const expiresMs = isYearly ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
        const isVip = user?.is_vip || false
        const actualDripRate = dripRate + (isVip ? VIP_EXTRA_DRIP_REDEEM : 0)

        const existingSub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(userId)
        if (existingSub) {
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active', welcome_bonus_claimed = 1,
            welcome_bonus_amount = ?, daily_drip_rate = ?, vip_discount_applied = ?,
            cycle = ?, started_at = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL WHERE user_id = ?`)
            .run(value, welcomeBonusQuota, actualDripRate, isVip ? 1 : 0, cycle, now, now + expiresMs, now, userId)
        } else {
          db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed, welcome_bonus_amount,
            daily_drip_rate, vip_discount_applied, cycle, started_at, expires_at, created_at)
            VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), userId, value, welcomeBonusQuota, actualDripRate, isVip ? 1 : 0, cycle, now, now + expiresMs, now)
        }

        db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(value, userId)

        db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
          .run(welcomeBonusQuota, userId)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'package', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, welcomeBonusQuota,
            `兑换码兑换 ${value}${isYearly ? '年付' : '月付'}套餐，红包 ${welcomeBonusPoints} 积分`, codeId, now)

        syncCreditBalance(userId)
        description = `兑换 ${value}${isYearly ? '年付' : '月付'}套餐`
        break
      }

      case 'vip': {
        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
        if (user?.is_vip) throw new Error('ALREADY_VIP')

        db.prepare('UPDATE users SET is_vip = 1, multiplier = 0.8 WHERE id = ?').run(userId)
        db.prepare(`UPDATE subscriptions SET daily_drip_rate = daily_drip_rate + ? WHERE user_id = ? AND status = 'active'`)
          .run(VIP_EXTRA_DRIP_REDEEM, userId)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'redemption', ?, ?)`)
          .run(uuidv4(), userId, 0, `兑换码兑换 VIP 终身会员`, codeId, now)
        description = '兑换 VIP 终身会员'
        break
      }

      default:
        throw new Error('INVALID_REDEMPTION_TYPE')
    }

    markRedemptionCodeUsed(codeId, userId)
    return { success: true, description }
  })

  return tx()
}
