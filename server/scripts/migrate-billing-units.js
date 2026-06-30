#!/usr/bin/env node
/**
 * 计费单位迁移脚本（Phase 5）
 *
 * 背景：计费改为「New API 实扣 quota 镜像本地账本」后，本地 credits 单位统一为
 * New API quota（500000=$1）。但存量用户的 credits.balance 是旧估算逻辑扣乱的
 * 旧单位值，与新单位/真实消费都对不上。
 *
 * 动作：把每个用户的 credits.balance 重置为「其账号类型的初始赠送额」（新单位 quota），
 * lifetime_consumed 归零，并写一条 admin_grant 类型流水留痕。
 *
 * 安全：
 *   - 默认 DRY-RUN（只打印将要做什么，不写库）。加 --apply 才真正执行。
 *   - 跑前请备份 Profer DB。
 *   - 只动 Profer 自己的 credits 表，不碰 New API。
 *
 * 用法：
 *   node server/scripts/migrate-billing-units.js            # dry-run 预览
 *   node server/scripts/migrate-billing-units.js --apply    # 真正执行
 */
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { DB_PATH, getAccountCapability } from '../src/config.js'

const APPLY = process.argv.includes('--apply')
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }

const db = new Database(DB_PATH)
const QPU = 500000

function fmtUSD(quota) { return '$' + (quota / QPU).toFixed(2) }

console.log(`${c.bold}计费单位迁移${c.reset}  DB=${DB_PATH}  模式=${APPLY ? c.yellow + 'APPLY(真写库)' + c.reset : c.green + 'DRY-RUN(只预览)' + c.reset}`)

const users = db.prepare('SELECT id, email, account_type FROM users').all()
console.log(`共 ${users.length} 个用户\n`)

const now = Date.now()

function migrate() {
  for (const u of users) {
    const grant = getAccountCapability(u.account_type).defaultCreditGrant
    const cur = db.prepare('SELECT balance, lifetime_consumed FROM credits WHERE user_id = ?').get(u.id)
    const oldBal = cur ? cur.balance : '(无行)'
    console.log(`  ${u.email} [${u.account_type}] 旧余额=${oldBal} → 新余额=${grant} (${fmtUSD(grant)})`)
    if (!APPLY) continue
    if (cur) {
      db.prepare('UPDATE credits SET balance = ?, lifetime_consumed = 0, updated_at = ? WHERE user_id = ?').run(grant, now, u.id)
    } else {
      db.prepare('INSERT INTO credits (user_id, balance, lifetime_consumed, updated_at) VALUES (?, ?, 0, ?)').run(u.id, grant, now)
    }
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, reference_type, reference_id, created_at)
      VALUES (?, ?, ?, 'admin_grant', ?, 'migration', ?, ?)`)
      .run(uuidv4(), u.id, grant, `计费单位迁移：重置为初始赠送额 ${grant} quota`, 'migrate-billing-units', now)
  }
}

if (APPLY) {
  db.transaction(migrate)()
  console.log(`\n${c.green}✓ 已执行：${users.length} 个用户余额已重置${c.reset}`)
} else {
  migrate()
  console.log(`\n${c.yellow}DRY-RUN 完成，未写库。确认无误后加 --apply 执行。${c.reset}`)
}
db.close()
