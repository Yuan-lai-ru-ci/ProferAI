#!/usr/bin/env node
/**
 * 每日 Drip 累加脚本
 *
 * 每天凌晨执行一次，从 config store 实时读取当前套餐 drip 速率，
 * 按订阅 plan + 用户 VIP 状态计算每日 drip，累加到 drip_available_this_week。
 * 同日重复执行幂等（按 drip_last_accrual_date 去重）。
 *
 * 用法：
 *   node server/scripts/accrue-daily-drip.js            # dry-run 预览
 *   node server/scripts/accrue-daily-drip.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { DB_PATH } from '../src/config.js'
import { getPlanDefs, getVipConfig } from '../src/db/config-store.js'

const APPLY = process.argv.includes('--apply')

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m' }

/** Asia/Shanghai 时区当天日期（YYYY-MM-DD），与 accrueDailyDrip / claimDrip 保持一致 */
function getChinaDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

const db = new Database(DB_PATH)
const today = getChinaDate()
const now = Date.now()

console.log(`${c.bold}每日 Drip 累加${c.reset}  日期=${today}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY' + c.reset : c.green + 'DRY-RUN' + c.reset}\n`)

const planDefs = getPlanDefs()
const vipConfig = getVipConfig()

// 查询所有 active 且未过期的订阅，join users 取 is_vip
const subs = db.prepare(
  `SELECT s.id, s.user_id, s.plan, s.drip_available_this_week, s.drip_last_accrual_date, u.is_vip
   FROM subscriptions s
   JOIN users u ON u.id = s.user_id
   WHERE s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > ?)`
).all(now)

let applied = 0
let skipped = 0

for (const sub of subs) {
  if (sub.drip_last_accrual_date === today) {
    console.log(`  ${c.dim}${sub.user_id} (${sub.plan}) 今日已累加，跳过${c.reset}`)
    skipped++
    continue
  }

  const plan = planDefs[sub.plan]
  if (!plan) {
    console.log(`  ${c.dim}${sub.user_id} (${sub.plan}) 套餐未定义，跳过${c.reset}`)
    skipped++
    continue
  }

  const dripPoints = plan.dailyDrip + (sub.is_vip ? vipConfig.extraDrip : 0)
  if (dripPoints <= 0) {
    console.log(`  ${c.dim}${sub.user_id} (${sub.plan}) drip_rate=0，跳过${c.reset}`)
    skipped++
    continue
  }

  // dripPoints 是积分单位，转为 quota（1 积分 = 50000 quota）
  const dripQuota = dripPoints * 50_000
  const before = sub.drip_available_this_week
  const after = before + dripQuota

  console.log(`  ${sub.user_id} (${sub.plan}${sub.is_vip ? '+VIP' : ''}) drip=${dripPoints}积分  可领池 ${before} → ${after} quota`)

  if (APPLY) {
    db.prepare('UPDATE subscriptions SET drip_available_this_week = ?, drip_last_accrual_date = ? WHERE id = ?')
      .run(after, today, sub.id)
    applied++
  }
}

console.log(`\n${subs.length} 个活跃订阅，${APPLY ? c.green + `已累加 ${applied} 个` + c.reset : c.yellow + `将累加 ${subs.length - skipped} 个（${skipped} 跳过）` + c.reset}`)
if (!APPLY) console.log(`${c.yellow}DRY-RUN 完成，未写库。确认无误后加 --apply 执行。${c.reset}`)

db.close()
