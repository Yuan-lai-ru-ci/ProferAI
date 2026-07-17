#!/usr/bin/env node
/**
 * 老用户迁移脚本 — 一次性将现有用户迁移到新定价方案
 *
 * 迁移规则：
 *   - 所有现有用户 → membership_tier = 'plus'（Plus 套餐）
 *   - 每人 500 积分（25,000,000 quota）到 balance_purchased
 *   - 确保每人有邀请码
 *
 * 已迁移的用户不重复处理（幂等）。
 *
 * 用法：
 *   node server/scripts/migrate-users-to-new-plan.js            # dry-run 预览
 *   node server/scripts/migrate-users-to-new-plan.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { DB_PATH } from '../src/config.js'

const APPLY = process.argv.includes('--apply')

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }

// 迁移标记（写在 credit_transactions.description 中，确保幂等）
const MIGRATION_TAG = 'migrate-to-plus-2026-07'

const MIGRATION_POINTS = 500
const MIGRATION_QUOTA = MIGRATION_POINTS * 50_000 // 25,000,000 quota

const db = new Database(DB_PATH)
const now = Date.now()

console.log(`${c.bold}老用户迁移 → 新定价方案${c.reset}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY' + c.reset : c.green + 'DRY-RUN' + c.reset}`)
console.log(`每人: Plus + ${MIGRATION_POINTS}积分(${MIGRATION_QUOTA} quota) + 邀请码\n`)

// 已迁移用户（通过 credit_transactions description 标记去重）
const alreadyMigrated = new Set(
  db.prepare("SELECT DISTINCT user_id FROM credit_transactions WHERE description LIKE '%' || ? || '%'")
    .all(MIGRATION_TAG)
    .map(r => r.user_id)
)

const users = db.prepare('SELECT id, email, display_name, account_type, membership_tier, is_vip FROM users').all()
console.log(`共 ${users.length} 个用户\n`)

let migrated = 0
let skipped = 0

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
      console.log(`  ${c.dim}${u.email} [${u.membership_tier || 'free'}] 已迁移，跳过${c.reset}`)
      skipped++
      continue
    }

    const oldTier = u.membership_tier || 'free'
    const oldVip = u.is_vip ? 'VIP' : '非VIP'
    console.log(`  ${u.email} [${oldTier}, ${oldVip}] → Plus+${MIGRATION_POINTS}积分`)

    if (!APPLY) continue
    migrated++

    // 设 Plus
    db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?')
      .run('plus', u.id)

    // 加 500 积分到 balance_purchased
    db.prepare('UPDATE users SET balance_purchased = balance_purchased + ? WHERE id = ?')
      .run(MIGRATION_QUOTA, u.id)

    // 同步 credits.balance
    const existing = db.prepare('SELECT user_id FROM credits WHERE user_id = ?').get(u.id)
    if (existing) {
      const totals = db.prepare('SELECT balance_package, balance_referral, balance_purchased FROM users WHERE id = ?').get(u.id)
      const total = (totals.balance_package || 0) + (totals.balance_referral || 0) + (totals.balance_purchased || 0)
      db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?').run(total, now, u.id)
    } else {
      db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)')
        .run(u.id, MIGRATION_QUOTA, now)
    }

    // 写流水
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'grant', ?, 'purchased', 'migration', ?, ?)`)
      .run(uuidv4(), u.id, MIGRATION_QUOTA,
        `${MIGRATION_TAG}：Plus+${MIGRATION_POINTS}积分`,
        'migrate-users-to-new-plan', now)

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
  console.log(`\n${c.green}✓ 已迁移 ${migrated} 个用户（${skipped} 个跳过）${c.reset}`)
} else {
  migrate()
  const eligible = users.length - skipped
  console.log(`\n${c.yellow}DRY-RUN 完成，未写库。${eligible} 个可迁移（${skipped} 个已有记录）。确认无误后加 --apply 执行。${c.reset}`)
}

db.close()
