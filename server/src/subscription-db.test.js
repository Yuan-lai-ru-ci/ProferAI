/**
 * 订阅 P0 数据库回归测试。
 *
 * 通过 bun:sqlite 适配器运行 subscription.js 的真实事务和 SQL，覆盖销毁、
 * 订单金额校验、提前续费、首购红包幂等及 cycle 持久化。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBunSqliteMock } from './test-helpers/sqlite-bun-adapter.js'

installBunSqliteMock(mock)

const MONTH_MS = 30 * 86400 * 1000
let tempDir
let dbModule

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'proma-subscription-db-'))
  process.env.JWT_SECRET = 'x'.repeat(64)
  process.env.DB_PATH = join(tempDir, 'test.db')
  process.env.DATA_DIR = tempDir
  process.env.DEFAULT_CREDIT_GRANT = '0'

  dbModule = await import('./db.js')
})

afterAll(() => {
  // Bun 可能在同一进程复用 db.js 单例，避免关闭后影响其他测试文件。
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }
})

function makeUser(id, membershipTier = 'free') {
  const { db, ensureCreditRow } = dbModule
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, membership_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, `${id}@example.com`, 'hash', id, membershipTier, Date.now())
  ensureCreditRow(id)
  db.prepare('UPDATE users SET balance_package = 0, balance_purchased = 0, balance_referral = 0 WHERE id = ?').run(id)
  db.prepare('UPDATE credits SET balance = 0 WHERE user_id = ?').run(id)
  return id
}

function makeSubscriptionOrder(userId, { plan = 'standard', cycle = 'monthly', amountRmb } = {}) {
  const { createOrder, getExpectedSubscriptionAmountRmb } = dbModule
  const expected = getExpectedSubscriptionAmountRmb(userId, plan, cycle)
  return createOrder({
    userId,
    type: 'subscription',
    plan,
    cycle,
    amountRmb: amountRmb ?? expected,
    credits: 0,
  }).id
}

function getUserBalances(userId) {
  return dbModule.db.prepare(
    'SELECT membership_tier, balance_package, balance_purchased, balance_referral FROM users WHERE id = ?',
  ).get(userId)
}

describe('单用户 drip 累计', () => {
  test('Given 两个活跃订阅 When 仅为 A 累计 Then B 的 drip 不被请求路径修改且同日幂等', () => {
    const { db, accrueDailyDripForUser } = dbModule
    const now = Date.parse('2026-07-21T09:00:00+08:00')
    const userA = makeUser('sub-drip-user-a', 'standard')
    const userB = makeUser('sub-drip-user-b', 'standard')
    for (const [id, userId] of [['subscription-drip-user-a', userA], ['subscription-drip-user-b', userB]]) {
      db.prepare(`INSERT INTO subscriptions
        (id, user_id, plan, status, daily_drip_rate, started_at, expires_at, created_at)
        VALUES (?, ?, 'standard', 'active', 1, ?, ?, ?)`)
        .run(id, userId, now - MONTH_MS, now + MONTH_MS, now)
    }

    expect(accrueDailyDripForUser(userA, now)).toBe(1)
    expect(accrueDailyDripForUser(userA, now)).toBe(0)
    expect(db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userA).drip_available_this_week).toBeGreaterThan(0)
    expect(db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userB).drip_available_this_week).toBe(0)
  })
})

describe('周 drip 过期与补偿', () => {
  test('Given 上海周日与下周一 When 计算周键 Then 返回各自周一且不受 UTC 日界影响', () => {
    const { getChinaDate, getChinaWeekStart } = dbModule
    const sunday = new Date('2026-07-19T15:59:00.000Z') // 上海周日 23:59
    const monday = new Date('2026-07-19T16:00:00.000Z') // 上海周一 00:00
    expect(getChinaDate(sunday)).toBe('2026-07-19')
    expect(getChinaWeekStart(sunday)).toBe('2026-07-13')
    expect(getChinaDate(monday)).toBe('2026-07-20')
    expect(getChinaWeekStart(monday)).toBe('2026-07-20')
  })

  test('Given 旧周未领取 drip When 清理器跨周执行两次 Then 只清一次且只产生一条审计流水', () => {
    const { db, clearWeeklyDrip } = dbModule
    const userId = makeUser('sub-drip-expiry')
    const now = Date.parse('2026-07-20T01:00:00+08:00')
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, drip_available_this_week, drip_week_start, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?, ?, ?)`)
      .run('subscription-drip-expiry', userId, now - MONTH_MS, now + MONTH_MS, 123456, '2026-07-13', now)

    expect(clearWeeklyDrip(now)).toEqual({ clearedCount: 1, forfeitedQuota: 123456 })
    expect(clearWeeklyDrip(now)).toEqual({ clearedCount: 0, forfeitedQuota: 0 })
    expect(db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE id = ?').get('subscription-drip-expiry').drip_available_this_week).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE reference_type = 'drip_weekly_clear' AND reference_id = ?").get('subscription-drip-expiry').count).toBe(1)
  })

  test('Given 当前周未领取 drip When 清理器执行 Then 保留该周余额', () => {
    const { db, clearWeeklyDrip } = dbModule
    const userId = makeUser('sub-drip-current-week')
    const now = Date.parse('2026-07-20T01:00:00+08:00')
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, drip_available_this_week, drip_week_start, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?, ?, ?)`)
      .run('subscription-drip-current-week', userId, now - MONTH_MS, now + MONTH_MS, 654321, '2026-07-20', now)

    expect(clearWeeklyDrip(now)).toEqual({ clearedCount: 0, forfeitedQuota: 0 })
    expect(db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE id = ?').get('subscription-drip-current-week').drip_available_this_week).toBe(654321)
  })
})

describe('Drip 手动领取与订阅到期', () => {
  test('Given accrued drip When user has not explicitly claimed Then only the pending pool changes', () => {
    const { db, accrueDailyDripForUser, claimDrip } = dbModule
    const userId = makeUser('sub-drip-explicit-claim')
    const now = Date.parse('2026-07-21T09:00:00+08:00')
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, daily_drip_rate, started_at, expires_at, created_at)
      VALUES (?, ?, 'standard', 'active', 8, ?, ?, ?)`)
      .run('subscription-drip-explicit-claim', userId, now - MONTH_MS, now + MONTH_MS, now)

    expect(accrueDailyDripForUser(userId, now)).toBe(1)
    const pending = db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userId).drip_available_this_week
    expect(pending).toBeGreaterThan(0)
    expect(getUserBalances(userId).balance_package).toBe(0)
    expect(db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(userId).balance).toBe(0)

    expect(claimDrip(userId)).toBe(pending)
    expect(claimDrip(userId)).toBe(0)
    expect(getUserBalances(userId).balance_package).toBe(pending)
    expect(db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(userId).balance).toBe(pending)
    expect(db.prepare('SELECT drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userId).drip_available_this_week).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE user_id = ? AND type = 'drip_claim'").get(userId).count).toBe(1)
  })

  test('Given an expired active subscription When claiming or expiring it Then pending drip cannot enter balance and is audited as forfeited', () => {
    const { db, claimDrip, expireSubscription } = dbModule
    const userId = makeUser('sub-drip-expired')
    const now = Date.now()
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, drip_available_this_week, drip_week_start, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?, '2026-07-13', ?)`)
      .run('subscription-drip-expired', userId, now - MONTH_MS, now - 1, 400000, now)

    expect(claimDrip(userId)).toBe(0)
    expect(getUserBalances(userId).balance_package).toBe(0)
    expect(expireSubscription(userId)).toBe(true)
    expect(db.prepare('SELECT status, drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userId))
      .toEqual({ status: 'expired', drip_available_this_week: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE user_id = ? AND reference_type = 'drip_subscription_expiry'").get(userId).count).toBe(1)
  })

  test('Given an expired subscription with a pending pool When it is repurchased Then old drip state is reset instead of revived', () => {
    const { db, confirmOrder } = dbModule
    const userId = makeUser('sub-drip-repurchase')
    const now = Date.now()
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, welcome_bonus_claimed, daily_drip_rate, started_at, expires_at,
       drip_available_this_week, drip_week_start, drip_last_accrual_date, drip_last_claimed_date, created_at)
      VALUES (?, ?, 'standard', 'expired', 1, 8, ?, ?, 400000, '2026-07-13', '2026-07-19', '2026-07-19', ?)`)
      .run('subscription-drip-repurchase', userId, now - MONTH_MS, now - 1, now)

    confirmOrder(makeSubscriptionOrder(userId), 'admin-test')
    expect(db.prepare(`SELECT status, drip_available_this_week, drip_week_start, drip_last_accrual_date, drip_last_claimed_date
      FROM subscriptions WHERE user_id = ?`).get(userId)).toEqual({
      status: 'active', drip_available_this_week: 0, drip_week_start: null, drip_last_accrual_date: null, drip_last_claimed_date: null,
    })
  })

  test('Given a topup order When confirmed Then credits mirror is synchronized from the purchased bucket', () => {
    const { db, createOrder, confirmOrder } = dbModule
    const userId = makeUser('sub-topup-mirror')
    const order = createOrder({ userId, type: 'topup', amountRmb: 100, credits: 5 })
    confirmOrder(order.id, 'admin-test')
    expect(getUserBalances(userId).balance_purchased).toBe(250000)
    expect(db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(userId).balance).toBe(250000)
  })

  test('Given a subscription with pending drip When it is destroyed Then the pool is forfeited and cannot be revived', () => {
    const { db, destroySubscription } = dbModule
    const userId = makeUser('sub-drip-destroy', 'standard')
    const now = Date.now()
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, drip_available_this_week, drip_week_start, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?, '2026-07-20', ?)`)
      .run('subscription-drip-destroy', userId, now - MONTH_MS, now + MONTH_MS, 400000, now)

    expect(destroySubscription(userId)).toBe(true)
    expect(db.prepare('SELECT status, drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userId))
      .toEqual({ status: 'destroyed', drip_available_this_week: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE user_id = ? AND reference_type = 'drip_subscription_expiry'").get(userId).count).toBe(1)
  })

  test('Given an expired subscription with pending drip When it is frozen Then the pool is forfeited and unfreeze rejects it', () => {
    const { db, freezeSubscription, unfreezeSubscription } = dbModule
    const userId = makeUser('sub-drip-freeze', 'standard')
    const now = Date.now()
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, drip_available_this_week, drip_week_start, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?, '2026-07-13', ?)`)
      .run('subscription-drip-freeze', userId, now - MONTH_MS, now - 1, 400000, now)

    expect(freezeSubscription(userId)).toBe(true)
    expect(unfreezeSubscription(userId)).toBe(false)
    expect(db.prepare('SELECT status, drip_available_this_week FROM subscriptions WHERE user_id = ?').get(userId))
      .toEqual({ status: 'frozen', drip_available_this_week: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM credit_transactions WHERE user_id = ? AND reference_type = 'drip_subscription_expiry'").get(userId).count).toBe(1)
  })
})

describe('subscription P0 regressions', () => {
  test('Given an active paid subscription When destroySubscription tier downgrade fails Then the subscription destruction is rolled back atomically', () => {
    const { db, destroySubscription } = dbModule
    const userId = makeUser('sub-destroy-atomic', 'standard')
    const now = Date.now()
    db.prepare(`INSERT INTO subscriptions
      (id, user_id, plan, status, started_at, expires_at, created_at)
      VALUES (?, ?, 'standard', 'active', ?, ?, ?)`)
      .run('subscription-destroy-atomic', userId, now, now + MONTH_MS, now)

    db.exec(`CREATE TRIGGER fail_test_tier_downgrade
      BEFORE UPDATE OF membership_tier ON users
      WHEN NEW.id = 'sub-destroy-atomic'
      BEGIN
        SELECT RAISE(ABORT, 'forced tier downgrade failure');
      END`)

    try {
      expect(() => destroySubscription(userId)).toThrow(/forced tier downgrade failure/)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_test_tier_downgrade')
    }

    expect(db.prepare('SELECT status, destroyed_at FROM subscriptions WHERE user_id = ?').get(userId))
      .toEqual({ status: 'active', destroyed_at: null })
    expect(getUserBalances(userId).membership_tier).toBe('standard')
  })

  test('Given a pending subscription order with a mismatched amount When confirmOrder runs Then it rejects without paying the order or granting benefits', () => {
    const { db, confirmOrder, getExpectedSubscriptionAmountRmb } = dbModule
    const userId = makeUser('sub-amount-mismatch')
    const expected = getExpectedSubscriptionAmountRmb(userId, 'standard', 'monthly')
    const orderId = makeSubscriptionOrder(userId, { amountRmb: expected - 1 })

    expect(() => confirmOrder(orderId, 'admin-test')).toThrow('SUBSCRIPTION_AMOUNT_MISMATCH')

    const order = db.prepare('SELECT status, confirmed_by, confirmed_at FROM orders WHERE id = ?').get(orderId)
    expect(order).toEqual({ status: 'pending', confirmed_by: null, confirmed_at: null })
    expect(db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE user_id = ?').get(userId).count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM credit_transactions WHERE reference_id = ?').get(orderId).count).toBe(0)
    expect(getUserBalances(userId)).toEqual({
      membership_tier: 'free',
      balance_package: 0,
      balance_purchased: 0,
      balance_referral: 0,
    })
  })

  test('Given an active subscription with time remaining When a monthly renewal is confirmed early Then the new month starts after the original expiry', () => {
    const { db, confirmOrder } = dbModule
    const userId = makeUser('sub-early-renewal')
    const firstOrderId = makeSubscriptionOrder(userId)
    confirmOrder(firstOrderId, 'admin-test')
    const originalExpiry = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id = ?').get(userId).expires_at

    const renewalOrderId = makeSubscriptionOrder(userId)
    confirmOrder(renewalOrderId, 'admin-test')
    const renewed = db.prepare('SELECT expires_at, renewed_at FROM subscriptions WHERE user_id = ?').get(userId)

    expect(renewed.expires_at).toBe(originalExpiry + MONTH_MS)
    expect(renewed.renewed_at).toBeGreaterThan(0)
  })

  test('Given a subscriber who already received the welcome bonus When another subscription order is confirmed Then no second welcome bonus is granted', () => {
    const { db, confirmOrder } = dbModule
    const userId = makeUser('sub-welcome-once')
    const firstOrderId = makeSubscriptionOrder(userId)
    confirmOrder(firstOrderId, 'admin-test')
    const balanceAfterFirstOrder = getUserBalances(userId).balance_package

    const secondOrderId = makeSubscriptionOrder(userId)
    confirmOrder(secondOrderId, 'admin-test')

    expect(getUserBalances(userId).balance_package).toBe(balanceAfterFirstOrder)
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM credit_transactions WHERE user_id = ? AND source_balance = 'package' AND reference_type = 'order'",
    ).get(userId).count).toBe(1)
    expect(db.prepare('SELECT welcome_bonus_claimed FROM subscriptions WHERE user_id = ?').get(userId).welcome_bonus_claimed).toBe(1)
  })

  test('Given a yearly subscription order When confirmOrder succeeds Then the yearly cycle is persisted on the subscription', () => {
    const { db, confirmOrder, getSubscriptionStatus } = dbModule
    const userId = makeUser('sub-cycle-yearly')
    const orderId = makeSubscriptionOrder(userId, { plan: 'plus', cycle: 'yearly' })

    confirmOrder(orderId, 'admin-test')

    expect(db.prepare('SELECT cycle FROM orders WHERE id = ?').get(orderId).cycle).toBe('yearly')
    expect(db.prepare('SELECT cycle FROM subscriptions WHERE user_id = ?').get(userId).cycle).toBe('yearly')
    expect(getSubscriptionStatus(userId).cycle).toBe('yearly')
  })
})
