/**
 * 订阅/订单/邀请/drip/兑换码 业务逻辑
 *
 * 依赖 schema.js（db 实例）和 credits.js（额度操作）。
 * 所有订阅生命周期、订单确认、返利、drip 操作集中在此模块。
 */
import { db } from './schema.js'
import { ensureCreditRow, syncCreditBalance, pointsToQuota } from './credits.js'
import { getPlanDefs, getPlanDefsRedeem, getVipConfig } from './config-store.js'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

// ===== 时区工具 =====

/** 返回 Asia/Shanghai 时区的当天日期（YYYY-MM-DD），用于 drip 日切。 */
export function getChinaDate(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type) => parts.find(part => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** 返回 Asia/Shanghai 自然周的周一日期（YYYY-MM-DD）。 */
export function getChinaWeekStart(input = new Date()) {
  const chinaDate = getChinaDate(input)
  const [year, month, day] = chinaDate.split('-').map(Number)
  // 以 UTC 承载已换算出的中国日历日期，避免服务器本地时区影响星期计算。
  const utc = new Date(Date.UTC(year, month - 1, day))
  const mondayOffset = (utc.getUTCDay() + 6) % 7
  utc.setUTCDate(utc.getUTCDate() - mondayOffset)
  return utc.toISOString().slice(0, 10)
}

function inferDripWeekStart(sub) {
  return sub.drip_week_start || (sub.drip_last_accrual_date ? getChinaWeekStart(`${sub.drip_last_accrual_date}T12:00:00+08:00`) : null)
}

/** 在调用方事务内执行；仅清除不属于 currentWeek 的未领 drip。 */
function forfeitDrip(sub, { nextWeekStart = null, referenceType, description }, now) {
  const available = sub.drip_available_this_week || 0
  if (available <= 0) return 0

  db.prepare('UPDATE subscriptions SET drip_available_this_week = 0, drip_week_start = ? WHERE id = ?')
    .run(nextWeekStart, sub.id)
  db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
    VALUES (?, ?, ?, 'drip_expiry', ?, 'package', ?, ?, ?)`)
    .run(uuidv4(), sub.user_id, 0, description(available), referenceType, sub.id, now)
  return available
}

function expireStaleDrip(sub, currentWeek, now) {
  const available = sub.drip_available_this_week || 0
  if (available <= 0) return 0
  const ownedWeek = inferDripWeekStart(sub)
  if (ownedWeek === currentWeek) return 0

  return forfeitDrip(sub, {
    nextWeekStart: currentWeek,
    referenceType: 'drip_weekly_clear',
    description: (amount) => ownedWeek
      ? `周清零：${ownedWeek} 未领 drip ${Math.round(amount / 50000)} 积分`
      : `周清零：历史未归属 drip ${Math.round(amount / 50000)} 积分`,
  }, now)
}

// ===== 套餐定价（从 config-store 动态获取，Admin 操控面板可实时调整） =====
// 不再硬编码 PLAN_DEFS / VIP_DISCOUNT / VIP_EXTRA_DRIP；
// 改为在业务函数内调用 getPlanDefs() / getVipConfig() 获取最新值。

const NEWAPI_QPU = 500000 // quota per $1 unit

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

/** 计算套餐订单应收金额（人民币分），价格只由服务端配置和用户 VIP 状态决定。 */
export function getExpectedSubscriptionAmountRmb(userId, planId, cycle = 'monthly') {
  const plan = getPlanDefs()[planId]
  if (!plan || !['monthly', 'yearly'].includes(cycle)) throw new Error('INVALID_SUBSCRIPTION_ORDER')
  const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
  const baseRmb = cycle === 'yearly' ? plan.yearlyRmb : plan.monthlyRmb
  return user?.is_vip ? Math.round(baseRmb * getVipConfig().discount) : baseRmb
}

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
        syncCreditBalance(order.user_id)
        break

      case 'vip':
        db.prepare('UPDATE users SET is_vip = 1, multiplier = 0.8 WHERE id = ?')
          .run(order.user_id)
        db.prepare(`UPDATE subscriptions SET daily_drip_rate = daily_drip_rate + ? WHERE user_id = ? AND status = 'active'`)
          .run(getVipConfig().extraDrip, order.user_id)
        db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
          VALUES (?, ?, ?, 'topup', ?, 'purchased', 'order', ?, ?)`)
          .run(uuidv4(), order.user_id, 0,
            `VIP 终身会员 ¥${(order.amount_rmb / 100).toFixed(2)}`,
            orderId, now)
        break

      case 'subscription': {
        const plan = getPlanDefs()[order.plan]
        const cycle = order.cycle || 'monthly'
        if (!plan || !['monthly', 'yearly'].includes(cycle)) throw new Error('INVALID_SUBSCRIPTION_ORDER')

        const expectedAmountRmb = getExpectedSubscriptionAmountRmb(order.user_id, order.plan, cycle)
        if (order.amount_rmb !== expectedAmountRmb) throw new Error('SUBSCRIPTION_AMOUNT_MISMATCH')

        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(order.user_id)
        const isVip = !!user?.is_vip
        const bonusMultiplier = cycle === 'yearly' ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)
        const dripRate = plan.dailyDrip + (isVip ? getVipConfig().extraDrip : 0)
        const expiresMs = cycle === 'yearly' ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        const existingSub = db.prepare(`SELECT id, user_id, status, expires_at, welcome_bonus_claimed,
          drip_available_this_week, drip_week_start FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(order.user_id)
        const isActiveRenewal = existingSub?.status === 'active' && (!existingSub.expires_at || existingSub.expires_at > now)
        const expiresAt = (isActiveRenewal ? existingSub.expires_at : now) + expiresMs
        const grantWelcomeBonus = !existingSub?.welcome_bonus_claimed

        if (existingSub) {
          if (!isActiveRenewal) {
            forfeitDrip(existingSub, {
              referenceType: 'drip_subscription_expiry',
              description: (amount) => `套餐重新开通：过期未领取 drip ${Math.round(amount / 50000)} 积分失效`,
            }, now)
          }
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active',
            welcome_bonus_claimed = CASE WHEN welcome_bonus_claimed = 1 THEN 1 ELSE ? END,
            welcome_bonus_amount = CASE WHEN welcome_bonus_claimed = 1 THEN welcome_bonus_amount ELSE ? END,
            daily_drip_rate = ?, vip_discount_applied = ?, cycle = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL,
            drip_available_this_week = CASE WHEN ? THEN drip_available_this_week ELSE 0 END,
            drip_week_start = CASE WHEN ? THEN drip_week_start ELSE NULL END,
            drip_last_accrual_date = CASE WHEN ? THEN drip_last_accrual_date ELSE NULL END,
            drip_last_claimed_date = CASE WHEN ? THEN drip_last_claimed_date ELSE NULL END
            WHERE id = ?`)
            .run(order.plan, grantWelcomeBonus ? 1 : 0, welcomeBonusQuota, dripRate, isVip ? 1 : 0, cycle, expiresAt, now,
              isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, existingSub.id)
        } else {
          db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed, welcome_bonus_amount,
            daily_drip_rate, vip_discount_applied, cycle, started_at, expires_at, created_at)
            VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), order.user_id, order.plan, welcomeBonusQuota, dripRate, isVip ? 1 : 0, cycle, now, expiresAt, now)
        }

        db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(order.plan, order.user_id)

        if (grantWelcomeBonus) {
          db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?').run(welcomeBonusQuota, order.user_id)
          db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
            VALUES (?, ?, ?, 'topup', ?, 'package', 'order', ?, ?)`)
            .run(uuidv4(), order.user_id, welcomeBonusQuota,
              `${order.plan}${cycle === 'yearly' ? '年付' : '月付'} 首购红包 ${welcomeBonusPoints} 积分` + (isVip ? ' (VIP 9折)' : ''),
              orderId, now)
        }

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
  const sub = db.prepare(`
    SELECT s.*, u.membership_tier, u.is_vip, u.multiplier
    FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.status IN ('active', 'frozen')
    ORDER BY s.created_at DESC LIMIT 1
  `).get(userId)
  if (!sub) return null
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
    membershipTier: sub.membership_tier || 'free',
    isVip: !!sub.is_vip,
    multiplier: sub.multiplier || 1.0,
  }
}

/**
 * 立即取消套餐权益；套餐余额保留为可用余额，但付费 tier 必须在同一事务内撤销。
 */
export function destroySubscription(userId) {
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare("SELECT id, user_id, plan, drip_available_this_week FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(userId)
    if (!sub) return false

    db.prepare("UPDATE subscriptions SET status = 'destroyed', destroyed_at = ? WHERE id = ?")
      .run(now, sub.id)
    forfeitDrip(sub, {
      referenceType: 'drip_subscription_expiry',
      description: (amount) => `套餐销毁：${sub.plan} 未领取 drip ${Math.round(amount / 50000)} 积分失效`,
    }, now)
    db.prepare("UPDATE users SET membership_tier = 'free' WHERE id = ?").run(userId)
    return true
  })
  return tx()
}

/** 冻结套餐（到期未续，未领取 drip 随套餐失效） */
export function freezeSubscription(userId) {
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare("SELECT id, user_id, plan, drip_available_this_week FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at <= ? ORDER BY created_at DESC LIMIT 1")
      .get(userId, now)
    if (!sub) return false

    db.prepare("UPDATE subscriptions SET status = 'frozen' WHERE id = ?").run(sub.id)
    forfeitDrip(sub, {
      referenceType: 'drip_subscription_expiry',
      description: (amount) => `套餐冻结：${sub.plan} 未领取 drip ${Math.round(amount / 50000)} 积分失效`,
    }, now)
    return true
  })
  return tx()
}

/** 仅恢复仍在有效期内的冻结订阅；续费必须走订单确认路径。 */
export function unfreezeSubscription(userId) {
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare("SELECT id, user_id, plan, drip_available_this_week FROM subscriptions WHERE user_id = ? AND status = 'frozen' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1")
      .get(userId, now)
    if (!sub) return false

    // 防御历史数据或旧版本冻结流程遗留的待领取池。
    forfeitDrip(sub, {
      referenceType: 'drip_subscription_expiry',
      description: (amount) => `套餐恢复：${sub.plan} 未领取 drip ${Math.round(amount / 50000)} 积分失效`,
    }, now)
    db.prepare("UPDATE subscriptions SET status = 'active', renewed_at = ? WHERE id = ?")
      .run(now, sub.id)
    return true
  })
  return tx()
}

/** 升级套餐：补差价，红包不补，drip 立即提级 */
export function upgradeSubscription(userId, newPlan) {
  const plan = getPlanDefs()[newPlan]
  if (!plan) throw new Error('INVALID_PLAN')
  const now = Date.now()
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(userId)
  if (!sub) throw new Error('NO_ACTIVE_SUBSCRIPTION')
  if (sub.plan === newPlan) return

  const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
  const dripRate = plan.dailyDrip + (user?.is_vip ? getVipConfig().extraDrip : 0)

  db.prepare(`UPDATE subscriptions SET plan = ?, daily_drip_rate = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`)
    .run(newPlan, dripRate, now, userId)
  db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(newPlan, userId)
}

/** 标记到期（由定时任务调用）。事务内完成：订阅过期 + 降级 tier + 清零套餐积分桶 */
export function expireSubscription(userId) {
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare(
      "SELECT id, user_id, plan, drip_available_this_week FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at <= ?"
    ).get(userId, now)
    if (!sub) return false

    // 1. 标记订阅过期
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id)

    // 2. 未领取 drip 随套餐到期失效，绝不能在续费时复活。
    forfeitDrip(sub, {
      referenceType: 'drip_subscription_expiry',
      description: (amount) => `套餐到期：${sub.plan} 未领取 drip ${Math.round(amount / 50000)} 积分失效`,
    }, now)

    // 3. 降级 membership_tier
    db.prepare("UPDATE users SET membership_tier = 'free' WHERE id = ?").run(userId)

    // 4. 清零套餐积分桶（红包 + drip 随套餐失效，直充/返利保留）
    const user = db.prepare('SELECT balance_package FROM users WHERE id = ?').get(userId)
    const forfeited = user?.balance_package || 0
    if (forfeited > 0) {
      db.prepare('UPDATE users SET balance_package = 0 WHERE id = ?').run(userId)
      db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
        VALUES (?, ?, ?, 'expiry', ?, 'package', 'subscription_expiry', ?, ?)`)
        .run(uuidv4(), userId, -forfeited,
          `套餐到期：${sub.plan} → free，${Math.round(forfeited / 50000)} 积分失效`,
          sub.id, now)
    }

    // 5. 同步 credits.balance
    syncCreditBalance(userId)

    return true
  })
  return tx()
}

// ===== Drip 领取制 =====

function accrueDripForSubscriptions(subs, now) {
  const today = getChinaDate(now)
  const currentWeek = getChinaWeekStart(now)
  const planDefs = getPlanDefs()
  const vipConfig = getVipConfig()
  let accrued = 0

  for (const sub of subs) {
    expireStaleDrip(sub, currentWeek, now)
    if (sub.drip_last_accrual_date === today) continue
    const plan = planDefs[sub.plan]
    if (!plan) continue
    const dripPoints = plan.dailyDrip + (sub.is_vip ? vipConfig.extraDrip : 0)
    if (dripPoints <= 0) continue

    const dripQuota = pointsToQuota(dripPoints)
    db.prepare('UPDATE subscriptions SET drip_available_this_week = drip_available_this_week + ?, drip_last_accrual_date = ?, drip_week_start = ? WHERE id = ?')
      .run(dripQuota, today, currentWeek, sub.id)
    accrued++
  }
  return accrued
}

const ACTIVE_DRIP_SUBSCRIPTION_COLUMNS = `s.id, s.user_id, s.plan, s.drip_available_this_week,
  s.drip_last_accrual_date, s.drip_week_start, u.is_vip`

/** 仅为当前用户累计当天 drip，供账户请求路径使用，绝不扫描其它订阅。 */
export function accrueDailyDripForUser(userId, now = Date.now()) {
  if (!userId) return 0
  const tx = db.transaction(() => {
    const subs = db.prepare(`SELECT ${ACTIVE_DRIP_SUBSCRIPTION_COLUMNS}
      FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? AND s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)`)
      .all(userId, now)
    return accrueDripForSubscriptions(subs, now)
  })
  return tx()
}

/** 每日全局 drip 批处理，仅供 scheduler 补偿任务调用。 */
export function accrueDailyDrip(now = Date.now()) {
  const tx = db.transaction(() => {
    const subs = db.prepare(`SELECT ${ACTIVE_DRIP_SUBSCRIPTION_COLUMNS}
      FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)`)
      .all(now)
    return accrueDripForSubscriptions(subs, now)
  })
  return tx()
}

/** 领取本周全部 drip：drip_available_this_week → balance_package */
export function claimDrip(userId) {
  const today = getChinaDate()
  const now = Date.now()
  const tx = db.transaction(() => {
    const sub = db.prepare(
      "SELECT id, drip_available_this_week, drip_last_claimed_date FROM subscriptions WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1"
    ).get(userId, now)
    if (!sub || !sub.drip_available_this_week || sub.drip_available_this_week <= 0) return 0

    const amount = sub.drip_available_this_week
    ensureCreditRow(userId)
    db.prepare('UPDATE subscriptions SET drip_available_this_week = 0, drip_last_claimed_date = ? WHERE id = ?')
      .run(today, sub.id)
    db.prepare('UPDATE users SET balance_package = balance_package + ? WHERE id = ?')
      .run(amount, userId)
    syncCreditBalance(userId)
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'drip_claim', ?, 'package', 'drip_claim', ?, ?)`)
      .run(uuidv4(), userId, amount, `领取本周 drip ${Math.round(amount / 50000)} 积分`, sub.id, now)
    return amount
  })
  return tx()
}

/**
 * 跨周清零未领 drip。按中国自然周幂等补偿，不依赖在周日恰好触发。
 * @returns {{ clearedCount: number, forfeitedQuota: number }}
 */
export function clearWeeklyDrip(now = Date.now()) {
  const currentWeek = getChinaWeekStart(now)
  const tx = db.transaction(() => {
    const subs = db.prepare(
      "SELECT id, user_id, drip_available_this_week, drip_last_accrual_date, drip_week_start FROM subscriptions WHERE status = 'active' AND drip_available_this_week > 0"
    ).all()

    let clearedCount = 0
    let forfeitedQuota = 0
    for (const sub of subs) {
      const forfeited = expireStaleDrip(sub, currentWeek, now)
      if (forfeited > 0) {
        clearedCount++
        forfeitedQuota += forfeited
      }
    }
    return { clearedCount, forfeitedQuota }
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
        const plan = getPlanDefsRedeem()[value]
        if (!plan) throw new Error('INVALID_PLAN')
        const isYearly = cycle === 'yearly'
        const bonusMultiplier = isYearly ? 12 : 1
        const welcomeBonusPoints = plan.welcomeBonus * bonusMultiplier
        const welcomeBonusQuota = pointsToQuota(welcomeBonusPoints)
        const dripRate = plan.dailyDrip
        const expiresMs = isYearly ? 365 * 86400 * 1000 : 30 * 86400 * 1000

        const user = db.prepare('SELECT is_vip FROM users WHERE id = ?').get(userId)
        const isVip = user?.is_vip || false
        const actualDripRate = dripRate + (isVip ? getVipConfig().extraDrip : 0)

        const existingSub = db.prepare(`SELECT id, user_id, status, expires_at, drip_available_this_week, drip_week_start
          FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).get(userId)
        const isActiveRenewal = existingSub?.status === 'active' && (!existingSub.expires_at || existingSub.expires_at > now)
        const expiresAt = (isActiveRenewal ? existingSub.expires_at : now) + expiresMs
        if (existingSub) {
          if (!isActiveRenewal) {
            forfeitDrip(existingSub, {
              referenceType: 'drip_subscription_expiry',
              description: (amount) => `套餐重新开通：过期未领取 drip ${Math.round(amount / 50000)} 积分失效`,
            }, now)
          }
          db.prepare(`UPDATE subscriptions SET plan = ?, status = 'active', welcome_bonus_claimed = 1,
            welcome_bonus_amount = ?, daily_drip_rate = ?, vip_discount_applied = ?,
            cycle = ?, started_at = ?, expires_at = ?, renewed_at = ?, destroyed_at = NULL,
            drip_available_this_week = CASE WHEN ? THEN drip_available_this_week ELSE 0 END,
            drip_week_start = CASE WHEN ? THEN drip_week_start ELSE NULL END,
            drip_last_accrual_date = CASE WHEN ? THEN drip_last_accrual_date ELSE NULL END,
            drip_last_claimed_date = CASE WHEN ? THEN drip_last_claimed_date ELSE NULL END
            WHERE id = ?`)
            .run(value, welcomeBonusQuota, actualDripRate, isVip ? 1 : 0, cycle, now, expiresAt, now,
              isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, isActiveRenewal ? 1 : 0, existingSub.id)
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
          .run(getVipConfig().extraDrip, userId)
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
