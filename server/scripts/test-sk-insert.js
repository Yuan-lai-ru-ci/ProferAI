#!/usr/bin/env node
/**
 * 🔴 仅供本地开发测试。
 *
 * ADMIN 令牌必须通过环境变量 NEWAPI_ADMIN_TOKEN 提供。
 * 用法: NEWAPI_ADMIN_TOKEN=sk-xxx node server/scripts/test-sk-insert.js
 *
 * ⚠ 禁止在文件中硬编码令牌。
 */
const BASE = 'http://172.17.0.1:3080';
const ADMIN = process.env.NEWAPI_ADMIN_TOKEN;
if (!ADMIN) {
  console.error('请在环境变量中设置 NEWAPI_ADMIN_TOKEN');
  process.exit(1);
}
const crypto = require('crypto')
const { execSync } = require('child_process')

const skKey = 'sk-profer-' + crypto.randomBytes(12).toString('hex')

async function main() {
  // 1. Create user via API
  const ts = Date.now()
  const uname = 'sk' + ts.toString().slice(-8)
  const pwd = 'Sk' + ts.toString().slice(-6) + 'aA9'

  const cr = await fetch(BASE + '/api/user/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN, 'New-API-User': '2' },
    body: JSON.stringify({ username: uname, password: pwd, display_name: 'SKTest' }),
    signal: AbortSignal.timeout(10000),
  })
  const se = await fetch(BASE + '/api/user/search?keyword=' + uname, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN, 'New-API-User': '2' },
  })
  const seJson = await se.json()
  const newId = seJson?.data?.items?.[0]?.id
  console.log('1. User created, id:', newId)

  // 2. Insert sk- key directly into SQLite
  const now = Math.floor(Date.now() / 1000)
  const sql = `INSERT INTO tokens (user_id, key, status, name, created_time, accessed_time, expired_time, remain_quota, unlimited_quota, \`group\`) VALUES (${newId}, '${skKey}', 1, 'profer-auto', ${now}, ${now}, -1, 0, 1, 'default')`
  execSync(`docker exec new-api sqlite3 /data/one-api.db "${sql}"`, { encoding: 'utf8', timeout: 5000 })
  console.log('2. sk- key inserted:', skKey.slice(0, 25) + '...')

  // 3. TEST: Call API with this sk- key
  console.log('3. Testing API call...')
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + skKey },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'say hi in 3 words' }], max_tokens: 10 }),
    signal: AbortSignal.timeout(60000),
  })
  const rText = await r.text()
  const reqId = r.headers.get('x-oneapi-request-id')
  console.log('  HTTP', r.status, '| req-id:', reqId?.slice(0, 30) || 'NONE')

  if (r.status === 200) {
    // Wait for log to be written
    await new Promise(r => setTimeout(r, 2000))

    // 4. Check log attribution
    const logCheck = await fetch(BASE + '/api/log/?p=0&page_size=5', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN, 'New-API-User': '2' },
    })
    const logJson = await logCheck.json()
    const ourLog = logJson?.data?.items?.find(l => l.request_id === reqId)
    if (ourLog) {
      const correct = ourLog.user_id === newId
      console.log('4. Log attribution:')
      console.log('  user_id:', ourLog.user_id, correct ? '✅ CORRECT!' : '❌ WRONG (expected ' + newId + ')')
      console.log('  quota:', ourLog.quota, '| model:', ourLog.model_name)
      console.log('  tokens:', ourLog.prompt_tokens, '/', ourLog.completion_tokens)
    } else {
      console.log('4. Log entry NOT FOUND (may need more time)')
    }

    // 5. Check if quota was deducted from the user
    const quotaCheck = await fetch(BASE + '/api/user/self', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN, 'New-API-User': String(newId) },
    })
    const quotaJson = await quotaCheck.json()
    console.log('5. User quota after call:', JSON.stringify({ quota: quotaJson?.data?.quota, used_quota: quotaJson?.data?.used_quota }))
  } else {
    console.log('  FAILED:', rText.slice(0, 200))
  }

  // Cleanup
  execSync(`docker exec new-api sqlite3 /data/one-api.db "DELETE FROM tokens WHERE key = '${skKey}'"`, { encoding: 'utf8' })
  await fetch(BASE + '/api/user/' + newId, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ADMIN, 'New-API-User': '2' },
  })
  console.log('6. Cleaned up')
}
main().catch(e => console.error('ERROR:', e.message))
