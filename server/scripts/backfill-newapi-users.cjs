/**
 * 一次性存量迁移：为所有 new_api_key_encrypted IS NULL 的用户补建 New API 账号。
 *
 * 用法（在服务器容器内）：
 *   node server/scripts/backfill-newapi-users.cjs
 *
 * 需要的环境变量（与 server 相同）：
 *   RELAY_BASE_URL     — New API 地址（默认 http://127.0.0.1:3080）
 *   NEWAPI_ADMIN_TOKEN — New API 系统访问令牌
 *   NEWAPI_ADMIN_USER_ID — 令牌所属用户 id（默认 2）
 *   NEWAPI_USER_INITIAL_QUOTA — 初始额度 quota 单位（默认 5000000 = $10）
 *   DB_PATH            — Profer 团队库路径（默认 ./proma-team.db）
 */

const Database = require('better-sqlite3')
const crypto = require('crypto')

const BASE = process.env.RELAY_BASE_URL || 'http://127.0.0.1:3080'
const ADMIN = process.env.NEWAPI_ADMIN_TOKEN
const ADMIN_ID = process.env.NEWAPI_ADMIN_USER_ID || '2'
const INITIAL_QUOTA = parseInt(process.env.NEWAPI_USER_INITIAL_QUOTA || '5000000', 10)
const PROMA_DB_PATH = process.env.DB_PATH || './proma-team.db'
const NEWAPI_DB_PATH = '/app/new-api-data/one-api.db'

if (!ADMIN) {
  console.error('❌ NEWAPI_ADMIN_TOKEN 未设置')
  process.exit(1)
}

const proferDb = new Database(PROMA_DB_PATH, { readonly: false })
let newApiDb
try {
  newApiDb = new Database(NEWAPI_DB_PATH, { readonly: false })
} catch (e) {
  console.error(`❌ 无法打开 New API 数据库 (${NEWAPI_DB_PATH}): ${e.message}`)
  console.error('   请确认容器间 volume 挂载正确')
  proferDb.close()
  process.exit(1)
}

async function main() {
  const users = proferDb.prepare(
    'SELECT id, email, display_name FROM users WHERE new_api_key_encrypted IS NULL'
  ).all()

  console.log(`找到 ${users.length} 个待补建用户\n`)
  if (users.length === 0) {
    console.log('无需迁移。')
    proferDb.close()
    newApiDb.close()
    return
  }

  let ok = 0
  let fail = 0
  const now = Math.floor(Date.now() / 1000)

  for (const u of users) {
    const displayName = u.display_name || (u.email || '').split('@')[0]
    const label = `${u.email} (id=${u.id})`

    try {
      // 1. 创建 New API 用户
      const resp = await fetch(`${BASE}/api/user/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN}`,
          'New-API-User': ADMIN_ID,
        },
        body: JSON.stringify({ username: u.email, display_name: displayName }),
        signal: AbortSignal.timeout(10000),
      })

      const json = await resp.json()
      if (!json?.success || !json?.data?.id) {
        const msg = json?.message || JSON.stringify(json).slice(0, 150)
        console.error(`  ❌ ${label}: 创建用户失败 — ${msg}`)
        fail++
        continue
      }
      const newId = json.data.id

      // 2. 设额度（绕过 REST API，避免破坏密码）
      newApiDb.prepare('UPDATE users SET quota = ? WHERE id = ?').run(INITIAL_QUOTA, newId)

      // 3. 生成并插入 48 字符 token（纯 hex，无 sk- 前缀）
      const tokenKey = crypto.randomBytes(24).toString('hex')
      newApiDb.prepare(
        `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, \`group\`)
         VALUES (?, ?, 1, 'profer-auto', ?, ?, -1, 0, 1, 'default')`
      ).run(newId, tokenKey, now, now)

      // 4. 回写 Profer DB
      proferDb.prepare(
        'UPDATE users SET new_api_user_id = ?, new_api_key_encrypted = ? WHERE id = ?'
      ).run(newId, tokenKey, u.id)

      console.log(`  ✅ ${label} → newApiId=${newId}`)
      ok++
    } catch (e) {
      console.error(`  ❌ ${label}: ${e.message}`)
      fail++
    }
  }

  console.log(`\n完成: ${ok} 成功, ${fail} 失败`)
  proferDb.close()
  newApiDb.close()
}

main().catch((e) => {
  console.error('迁移脚本异常:', e.message)
  proferDb.close()
  newApiDb.close()
  process.exit(1)
})
