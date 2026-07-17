/**
 * 种子用户创建脚本（一次性，幂等）
 *
 * 用法: node server/scripts/seed-users.js
 *
 * 为冷启动创建 15 个种子用户，配置：
 *   VIP（is_vip=1, multiplier=0.8）+ Pro（membership_tier=pro）
 *   + 5000 积分（余额额度，$500 等价 = 5000 积分显示值）
 *   + 专属邀请码（每人 5 个名额通过邀请码自然传播）
 *
 * 密码随机生成，通过 log 输出，管理员手动分发。
 * 已存在的邮箱跳过不重复创建（幂等）。
 */

import { db, createInviteCode, ensureCreditRow } from '../src/db.js'
import { hashPassword } from '../src/utils.js'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'

// ===== 配置 =====
const SEED_CREDITS = 25_000_000  // quota 单位，显示为 $50 = 500 积分
const SEED_USERS = [
  // 按需修改邮箱和显示名
  { email: 'seed01@profer.local', displayName: '种子用户01' },
  { email: 'seed02@profer.local', displayName: '种子用户02' },
  { email: 'seed03@profer.local', displayName: '种子用户03' },
  { email: 'seed04@profer.local', displayName: '种子用户04' },
  { email: 'seed05@profer.local', displayName: '种子用户05' },
  { email: 'seed06@profer.local', displayName: '种子用户06' },
  { email: 'seed07@profer.local', displayName: '种子用户07' },
  { email: 'seed08@profer.local', displayName: '种子用户08' },
  { email: 'seed09@profer.local', displayName: '种子用户09' },
  { email: 'seed10@profer.local', displayName: '种子用户10' },
  { email: 'seed11@profer.local', displayName: '种子用户11' },
  { email: 'seed12@profer.local', displayName: '种子用户12' },
  { email: 'seed13@profer.local', displayName: '种子用户13' },
  { email: 'seed14@profer.local', displayName: '种子用户14' },
  { email: 'seed15@profer.local', displayName: '种子用户15' },
]

console.log(`[种子用户] 开始创建 ${SEED_USERS.length} 个种子用户...`)
const results = []

for (const u of SEED_USERS) {
  const now = Date.now()

  // 幂等：已存在则跳过
  const existing = db.prepare('SELECT id, email FROM users WHERE email = ?').get(u.email)
  if (existing) {
    console.log(`  ⏭ 跳过已存在: ${u.email} (id=${existing.id})`)
    // 确保已有用户也有邀请码
    const ic = createInviteCode(existing.id)
    results.push({ email: u.email, password: '(已存在)', inviteCode: ic, skipped: true })
    continue
  }

  const id = uuidv4()
  const password = crypto.randomBytes(8).toString('hex')
  const refreshToken = crypto.randomBytes(32).toString('hex')

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, display_name, is_vip, membership_tier, multiplier,
        account_type, balance_purchased, refresh_token, created_at)
      VALUES (?, ?, ?, ?, 1, 'pro', 0.8, 'advanced', ?, ?, ?)
    `).run(id, u.email, hashPassword(password), u.displayName, SEED_CREDITS, refreshToken, now)

    // 确保额度行
    ensureCreditRow(id)

    // 直接写额度（grantCredits 是给 admin 用的，种子用户直接设）
    db.prepare('UPDATE credits SET balance = ?, updated_at = ? WHERE user_id = ?')
      .run(SEED_CREDITS, now, id)

    // 流水记录
    db.prepare(`INSERT INTO credit_transactions (id, user_id, amount, type, description, source_balance, created_at)
      VALUES (?, ?, ?, 'grant', ?, 'purchased', ?)`)
      .run(uuidv4(), id, SEED_CREDITS, '种子用户初始积分', now)

    // 生成邀请码
    createInviteCode(id)
  })
  tx()

  const ic = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(id)?.code || ''
  results.push({ email: u.email, password, inviteCode: ic })
  console.log(`  ✅ ${u.email}  密码: ${password}  邀请码: ${ic}`)
}

console.log(`\n[种子用户] 完成: ${results.filter((r) => !r.skipped).length} 新建, ${results.filter((r) => r.skipped).length} 跳过`)
console.log('\n⚠️  请将以上密码和邀请码分发给对应种子用户。密码仅此一次输出，不会存储明文。')
console.log('   种子用户登录后应自行修改密码。')

// 汇总表
console.log('\n===== 汇总 =====')
console.log('邮箱\t\t\t密码\t\t邀请码')
for (const r of results) {
  console.log(`${r.email}\t${r.password}\t${r.inviteCode}`)
}

process.exit(0)
