#!/usr/bin/env node
/**
 * New API 方案 B 验证探针 — 登录铸 token 链路
 *
 * 验证：建用户(admin) → 登录该用户拿 session → 用 session 铸 token → 读回 key。
 * 这是"每用户独立账号"里铸 token 的安全路线（不直插 DB，缓存一致性由 New API 保证）。
 *
 * 全程对一个临时 probe_<ts> 用户操作，结束自动删除。token key 脱敏打印。
 *
 * 用法（在能连 New API 的环境，admin token = root1 的 access_token）：
 *   NEWAPI_ADMIN_TOKEN=<root1_access_token> NEWAPI_ADMIN_USER_ID=2 \
 *   RELAY_BASE_URL=http://172.17.0.1:3080 node /tmp/probe-scheme-b.js
 */

const BASE = process.env.RELAY_BASE_URL || 'http://127.0.0.1:3080'
const ADMIN = process.env.NEWAPI_ADMIN_TOKEN || ''
const ADMIN_UID = process.env.NEWAPI_ADMIN_USER_ID || '2'
const QPU = parseInt(process.env.NEWAPI_QUOTA_PER_UNIT || '500000', 10)

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' }
const mask = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***')
const log = (t) => console.log(t)
const hr = (t) => log(`\n${c.cyan}${c.bold}━━━ ${t} ━━━${c.reset}`)

if (!ADMIN) { console.error(`${c.red}缺少 NEWAPI_ADMIN_TOKEN${c.reset}`); process.exit(1) }

/** admin 身份请求 */
async function admin(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}`, 'New-API-User': ADMIN_UID },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  })
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: json ? json.success !== false : r.ok, json, raw: text.slice(0, 300), setCookie: r.headers.get('set-cookie') }
}

/** 带 cookie 的请求（用户 session） */
async function withCookie(method, path, cookie, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  })
  const text = await r.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: json ? json.success !== false : r.ok, json, raw: text.slice(0, 300), setCookie: r.headers.get('set-cookie') }
}

const sum = (r) => r.error ? `${c.red}ERR ${r.error}${c.reset}` : `${r.ok ? c.green : c.yellow}HTTP ${r.status} ok=${r.ok}${c.reset} ${c.dim}${r.json ? JSON.stringify(r.json).slice(0, 220) : r.raw}${c.reset}`

async function main() {
  log(`${c.bold}方案 B 探针${c.reset} base=${BASE} admin=${mask(ADMIN)} adminUid=${ADMIN_UID}`)
  // New API 用户名上限 12 字符，必须短名
  const uname = `pb${Date.now().toString().slice(-8)}`
  const pwd = `Pb${Date.now().toString().slice(-6)}aA9`
  let newId = null

  try {
    // 1. 建用户
    hr('1. 建用户 (admin)')
    const cr = await admin('POST', '/api/user/', { username: uname, password: pwd, display_name: 'probeB' })
    log(`  POST /api/user/  ${sum(cr)}`)
    if (!cr.ok) { log(`  ${c.red}建用户失败，中止${c.reset}`); return }

    // 2. 回查 id
    hr('2. 回查 user id (admin)')
    const se = await admin('GET', `/api/user/search?keyword=${uname}`)
    const items = se.json?.data?.items || se.json?.data || []
    newId = Array.isArray(items) ? items.find((u) => u.username === uname)?.id : null
    log(`  GET /api/user/search  → id=${newId ?? '(未取到)'}  ${sum(se)}`)
    if (newId == null) { log(`  ${c.red}拿不到 id，中止${c.reset}`); return }

    // 3. 先登录该用户拿 session（必须在任何 PUT /api/user/ 之前——PUT 疑似会清空密码）
    hr('3. 登录该用户拿 session（在改额度之前）')
    const login = await fetch(`${BASE}/api/user/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd }), signal: AbortSignal.timeout(10000),
    })
    const loginText = await login.text()
    let loginJson = null; try { loginJson = JSON.parse(loginText) } catch {}
    const setCookie = login.headers.get('set-cookie')
    log(`  POST /api/user/login  HTTP ${login.status} ok=${loginJson?.success}  ${c.dim}${loginText.slice(0, 120)}${c.reset}`)
    log(`  Set-Cookie: ${setCookie ? c.green + '有 ' + mask(setCookie) + c.reset : c.red + '无!' + c.reset}`)
    const cookie = setCookie ? setCookie.split(',').map((p) => p.trim().split(';')[0]).filter(Boolean).join('; ') : ''
    const loginUserId = loginJson?.data?.id
    log(`  登录返回 user.id = ${loginUserId} (应=${newId})`)

    // 4. 设 quota（登录之后；验证 PUT 是否影响后续）
    hr('4. 设初始 quota (admin，登录之后)')
    const q = await admin('PUT', '/api/user/', { id: newId, quota: QPU })
    log(`  PUT /api/user/ {id,quota}（不带password）  ${sum(q)}`)
    const relogin = await fetch(`${BASE}/api/user/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd }), signal: AbortSignal.timeout(10000),
    })
    const reloginJson = await relogin.json().catch(() => ({}))
    log(`  → 不带password的PUT后登录: ok=${reloginJson?.success} ${reloginJson?.success ? c.green + '✓未破坏' + c.reset : c.red + '✗破坏了密码' + c.reset}`)

    // 4b. 验证修法：PUT 带回 password 是否保住登录
    hr('4b. 修法验证：PUT 带 password 改额度')
    const q2 = await admin('PUT', '/api/user/', { id: newId, quota: QPU * 2, password: pwd })
    log(`  PUT /api/user/ {id,quota,password}  ${sum(q2)}`)
    const relogin2 = await fetch(`${BASE}/api/user/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd }), signal: AbortSignal.timeout(10000),
    })
    const relogin2Json = await relogin2.json().catch(() => ({}))
    log(`  → 带password的PUT后登录: ok=${relogin2Json?.success} ${relogin2Json?.success ? c.green + '✓ 修法成立：改额度带 password 即可保住登录' + c.reset : c.red + '✗ 仍失败，需换方式（如重置密码或专用额度接口）' + c.reset}`)

    // 5. 用 session 铸 token（试 cookie 单独 / cookie+New-API-User）
    hr('5. 用 session 铸 token')
    let tokenName = 'profer-main'
    let mint = await withCookie('POST', '/api/token/', cookie, { name: tokenName, remain_quota: -1, unlimited_quota: true, expired_time: -1 })
    log(`  POST /api/token/ [cookie]  ${sum(mint)}`)
    if (!mint.ok && loginUserId != null) {
      mint = await withCookie('POST', '/api/token/', cookie, { name: tokenName, remain_quota: -1, unlimited_quota: true, expired_time: -1 }, { 'New-API-User': String(loginUserId) })
      log(`  POST /api/token/ [cookie + New-API-User:${loginUserId}]  ${sum(mint)}`)
    }

    // 6. 读回 token key
    hr('6. 读回 token key')
    if (mint.ok) {
      // AddToken 通常不直接回 key，需 list 读
      const listByCookie = await withCookie('GET', '/api/token/?p=0&size=10', cookie, null, loginUserId != null ? { 'New-API-User': String(loginUserId) } : {})
      const toks = listByCookie.json?.data?.items || listByCookie.json?.data || []
      const mine = Array.isArray(toks) ? toks.find((t) => t.name === tokenName) : null
      log(`  GET /api/token/ [cookie]  → ${Array.isArray(toks) ? toks.length + ' 个' : '结构异常'}`)
      if (mine) {
        const k = mine.key || ''
        log(`  ${c.green}✓ 找到 token: name=${mine.name} keyLen=${k.length} 前缀=${k.slice(0, 3)} 末4=${k.slice(-4)} unlimited=${mine.unlimited_quota}${c.reset}`)
        log(`  ${c.dim}New API token key 不含 sk- 前缀；转发时用 Authorization: Bearer sk-<key> 或视渠道而定${c.reset}`)
        log(`  ${c.green}→ 方案 B 链路验证通过：建用户→登录→铸token→读key 全通${c.reset}`)
      } else {
        log(`  ${c.yellow}token 列表里没找到刚铸的，原始: ${listByCookie.raw}${c.reset}`)
      }
    } else {
      log(`  ${c.red}铸 token 失败，方案 B 此环境不通。原始: ${mint.raw}${c.reset}`)
    }
  } finally {
    // 7. 清理测试用户
    hr('7. 清理测试用户')
    if (newId != null) {
      const del = await admin('DELETE', `/api/user/${newId}`)
      log(`  DELETE /api/user/${newId}  ${sum(del)} ${del.ok ? c.green + '✓ 已删' + c.reset : c.red + '删除失败,请手动清 ' + uname + c.reset}`)
    } else {
      log(`  无 id,无需清理(用户可能没建成)`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
