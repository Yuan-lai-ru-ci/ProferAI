#!/usr/bin/env node
/**
 * 月初赠送额度脚本
 *
 * 每个用户加 $5 额度（= 5 × QUOTA_PER_UNIT quota），写 credit_transactions
 * 流水留痕。已给过的（通过 description 标记）不会重复发。
 *
 * 用法：
 *   node server/scripts/grant-monthly.js            # dry-run 预览
 *   node server/scripts/grant-monthly.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { DB_PATH, NEWAPI_QUOTA_PER_UNIT } from '../src/config.js'

const APPLY = process.argv.includes('--apply')
const GRANT_USD = 5
const GRANT_QUOTA = GRANT_USD * NEWAPI_QUOTA_PER_UNIT
const GRANT_TAG = `monthly-${new Date().toISOString().slice(0, 7)}` // 按当前年月(YYYY-MM)自动生成，每月唯一，防止重复发放

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }

const db = new Database(DB_PATH)

console.log(`${c.bold}月初 $${GRANT_USD} 赠送${c.reset}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY(真写库)' + c.reset : c.green + 'DRY-RUN(只预览)' + c.reset}`)
console.log(`每人 ${GRANT_QUOTA.toLocaleString()} quota (= $${GRANT_USD}.00)\n`)

const users = db.prepare('SELECT id, email, account_type FROM users').all()
console.log(`共 ${users.length} 个用户\n`)

// 查询已发过的用户（同月不重复）
const alreadyTagged = new Set(
  db.prepare("SELECT DISTINCT user_id FROM credit_transactions WHERE description LIKE '%' || ? || '%'")
    .all(GRANT_TAG)
    .map(r => r.user_id)
)

let applied = 0
let skipped = 0
const now = Date.now()

function migrate() {
  for (const u of users) {
    if (alreadyTagged.has(u.id)) {
      console.log(`  ${c.dim}${u.email} [${u.account_type}] 已赠送，跳过${c.reset}`)
      skipped++
      continue
    }

    // 确保有 credits 行
    const cur = db.prepare('SELECT balance FROM credits WHERE user_id = ?').get(u.id)
    const before = cur ? cur.balance : '(无行)'

    console.log(`  ${u.email} [${u.account_type}] 余额 ${before} → +${GRANT_QUOTA.toLocaleString()} quota`)

    if (!APPLY) continue
    applied++

    if (cur) {
      db.prepare('UPDATE credits SET balance = balance + ?, updated_at = ? WHERE user_id = ?')
        .run(GRANT_QUOTA, now, u.id)
    } else {
      db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)')
        .run(u.id, GRANT_QUOTA, now)
    }

    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'admin_grant', ?, 'monthly_grant', ?, ?)`)
      .run(uuidv4(), u.id, GRANT_QUOTA, `月初 $${GRANT_USD} 赠送 (${GRANT_TAG})`, 'grant-monthly', now)
  }
}

if (APPLY) {
  db.transaction(migrate)()
  console.log(`\n${c.green}✓ 已执行：${applied} 个用户各得 $${GRANT_USD}（${skipped} 个跳过）${c.reset}`)
} else {
  migrate()
  const eligible = users.length - skipped
  console.log(`\n${c.yellow}DRY-RUN 完成，未写库。${eligible} 个可发放（${skipped} 个已有记录）。确认无误后加 --apply 执行。${c.reset}`)
}
db.close()
