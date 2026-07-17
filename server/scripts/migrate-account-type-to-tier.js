#!/usr/bin/env node
/**
 * 账号制度统一迁移脚本 — 将存量用户迁移到订阅制
 *
 * 迁移内容：
 *   - 所有用户 → membership_tier = 'plus'
 *   - 每人建 1 个月 plus 订阅（从当天起 30 天）
 *   - 确保每人有邀请码
 *   - 已通过 migrate-users-to-new-plan-2026-07 迁移过（已是 pro+VIP）的用户跳过不降级
 *
 * 幂等：通过 credit_transactions.description 中的 MIGRATION_TAG 去重。
 *
 * 用法：
 *   node server/scripts/migrate-account-type-to-tier.js            # dry-run 预览
 *   node server/scripts/migrate-account-type-to-tier.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { DB_PATH } from '../src/config.js'

const APPLY = process.argv.includes('--apply')

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m' }

const MIGRATION_TAG = 'migrate-account-type-to-tier-2026-07'
const OLD_MIGRATION_TAG = 'migrate-to-new-plan-2026-07'

const SUBSCRIPTION_DURATION_MS = 30 * 86400 * 1000 // 1 个月

const db = new Database(DB_PATH)
const now = Date.now()

console.log(`${c.bold}账号制度统一迁移${c.reset}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY' + c.reset : c.green + 'DRY-RUN' + c.reset}`)
console.log(`内容: 所有用户 → plus + 1个月订阅 + 邀请码\n`)

// 已通过本次迁移处理过的用户
const alreadyMigrated = new Set(
  db.prepare("SELECT DISTINCT user_id FROM credit_transactions WHERE description LIKE '%' || ? || '%'")
    .all(MIGRATION_TAG)
    .map(r => r.user_id)
)

// 已通过旧迁移脚本处理过的用户（pro+VIP）—— 跳过不降级
const oldMigrated = new Set(
  db.prepare("SELECT DISTINCT user_id FROM credit_transactions WHERE description LIKE '%' || ? || '%'")
    .all(OLD_MIGRATION_TAG)
    .map(r => r.user_id)
)

const users = db.prepare('SELECT id, email, display_name, membership_tier, is_vip FROM users').all()
console.log(`共 ${users.length} 个用户\n`)

let migrated = 0
let skipped = 0
let skippedOld = 0

// 邀请码字符集
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function genCode() {
  let code = 'U'
  for (let i = 0; i < 6; i++) code += CHARS[crypto.randomInt(CHARS.length)]
  return code
}

function migrate() {
  for (const u of users) {
    if (alreadyMigrated.has(u.id)) {
      console.log(`  ${c.dim}${u.email} [${u.membership_tier || 'free'}] 本次已迁移，跳过${c.reset}`)
      skipped++
      continue
    }

    if (oldMigrated.has(u.id)) {
      console.log(`  ${c.cyan}${u.email} [${u.membership_tier || 'free'}${u.is_vip ? ', VIP' : ''}] 旧迁移已处理(pro+VIP)，跳过不降级${c.reset}`)
      skippedOld++
      continue
    }

    const oldTier = u.membership_tier || 'free'
    console.log(`  ${u.email} [${oldTier}] → plus + 1个月订阅`)

    if (!APPLY) continue
    migrated++

    // 设 membership_tier = 'plus'
    db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run('plus', u.id)

    // 建 1 个月 plus 订阅（已有订阅则更新，否则新建）
    const existingSub = db.prepare('SELECT id FROM subscriptions WHERE user_id = ?').get(u.id)
    if (existingSub) {
      db.prepare(`UPDATE subscriptions SET plan = 'plus', status = 'active',
        daily_drip_rate = ?, cycle = 'monthly', started_at = ?, expires_at = ?,
        renewed_at = ?, destroyed_at = NULL WHERE user_id = ?`)
        .run(20, now, now + SUBSCRIPTION_DURATION_MS, now, u.id)
    } else {
      db.prepare(`INSERT INTO subscriptions (id, user_id, plan, status, welcome_bonus_claimed,
        welcome_bonus_amount, daily_drip_rate, vip_discount_applied, cycle, started_at, expires_at, created_at)
        VALUES (?, ?, 'plus', 'active', 0, 0, 20, 0, 'monthly', ?, ?, ?)`)
        .run(uuidv4(), u.id, now, now + SUBSCRIPTION_DURATION_MS, now)
    }

    // 写流水（标记幂等）
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'grant', ?, 'purchased', 'migration', ?, ?)`)
      .run(uuidv4(), u.id, 0,
        `${MIGRATION_TAG}：统一为 plus + 1个月订阅`,
        'migrate-account-type-to-tier', now)

    // 确保有邀请码
    const existingCode = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(u.id)
    if (!existingCode) {
      let code, retries = 0
      do {
        code = genCode()
        retries++
      } while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code) && retries < 10)
      db.prepare('INSERT INTO invite_codes (id, user_id, code, created_at) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), u.id, code, now)
    }
  }
}

if (APPLY) {
  db.transaction(migrate)()
  const total = migrated + skipped + skippedOld
  console.log(`\n${c.green}✓ 已迁移 ${migrated} 个用户（${skipped} 个本次跳过，${skippedOld} 个旧迁移跳过）${c.reset}`)
} else {
  migrate()
  const eligible = users.length - skipped - skippedOld
  console.log(`\n${c.yellow}DRY-RUN 完成，未写库。${eligible} 个可迁移（${skipped} 个本次已有记录，${skippedOld} 个旧迁移保护）。确认无误后加 --apply 执行。${c.reset}`)
}

db.close()
