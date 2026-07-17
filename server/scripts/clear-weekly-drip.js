#!/usr/bin/env node
/**
 * 周清零脚本 — 清除未领取的每周 drip
 *
 * 每周日 23:55 执行，将 active subscription 的 drip_available_this_week 清零。
 * 未领部分直接过期，不到账 balance_package。
 *
 * 用法：
 *   node server/scripts/clear-weekly-drip.js            # dry-run 预览
 *   node server/scripts/clear-weekly-drip.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { DB_PATH } from '../src/config.js'

const APPLY = process.argv.includes('--apply')

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' }

const db = new Database(DB_PATH)
const now = Date.now()

console.log(`${c.bold}周 Drip 清零${c.reset}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY' + c.reset : c.green + 'DRY-RUN' + c.reset}\n`)

// 查询所有有未领 drip 的活跃订阅
const subs = db.prepare(
  `SELECT id, user_id, plan, drip_available_this_week
   FROM subscriptions WHERE status = 'active' AND drip_available_this_week > 0`
).all()

let cleared = 0
let totalForfeited = 0

for (const sub of subs) {
  const forfeited = sub.drip_available_this_week
  const points = Math.round(forfeited / 50_000)

  console.log(`  ${sub.user_id} (${sub.plan}) 过期未领 ${points} 积分 (${forfeited} quota)${c.red}`)

  if (APPLY) {
    db.prepare('UPDATE subscriptions SET drip_available_this_week = 0 WHERE id = ?').run(sub.id)
    // 记流水（amount=0，仅审计）
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, reference_type, reference_id, created_at)
      VALUES (?, ?, 0, 'drip_expiry', ?, 'package', 'drip_weekly_clear', ?, ?)`)
      .run(uuidv4(), sub.user_id, `周清零：过期 ${points} 积分 drip`, sub.id, now)
    cleared++
    totalForfeited += forfeited
  }
}

console.log(`\n${subs.length} 个订阅有待清 drip，总计 ${Math.round(totalForfeited / 50_000)} 积分`)
if (!APPLY) {
  console.log(`${c.yellow}DRY-RUN 完成，未写库。确认无误后加 --apply 执行。${c.reset}`)
} else {
  console.log(`${c.green}已清零 ${cleared} 个订阅的当周未领 drip${c.reset}`)
}

db.close()
