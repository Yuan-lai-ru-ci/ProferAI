#!/usr/bin/env node
/**
 * New API 接口探针 — Phase 0 验证脚本（默认只读）
 *
 * 目的：在动手"每用户独立 New API 账号"改造前，对真实 New API 实例验证 4 个未决机制：
 *   1. admin 鉴权头格式（Authorization: Bearer <token> 是否够，是否需 New-API-User 头）
 *   2. 查用户余额/quota 的真实响应结构（/api/user/self 或 /api/user/:id）
 *   3. quota 单位换算（QuotaPerUnit 是否 = 500000）
 *   4. 建用户 / 铸 token / 加额度 的真实调用与响应（仅 --write 时执行）
 *
 * 安全：
 *   - 默认只读：只列用户、查 quota、探鉴权，绝不建用户/改额度。
 *   - 写操作（建测试用户 + 铸 token + 加额度）必须显式加 --write，且只对一个临时测试邮箱操作。
 *   - 不打印 token 明文（脱敏）。
 *
 * 用法：
 *   NEWAPI_ADMIN_TOKEN=xxx RELAY_BASE_URL=http://47.109.108.57:3080 node server/scripts/newapi-probe.js
 *   ...同上... node server/scripts/newapi-probe.js --write   # 额外跑建用户/铸token/加额度
 */

const BASE = process.env.RELAY_BASE_URL || 'http://127.0.0.1:3080'
const ADMIN = process.env.NEWAPI_ADMIN_TOKEN || ''
const WRITE = process.argv.includes('--write')
const QUOTA_PER_UNIT = parseInt(process.env.NEWAPI_QUOTA_PER_UNIT || '500000', 10)

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' }
const mask = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '***')
function log(t) { console.log(t) }
function hr(t) { log(`\n${c.cyan}${c.bold}━━━ ${t} ━━━${c.reset}`) }

if (!ADMIN) {
  console.error(`${c.red}缺少 NEWAPI_ADMIN_TOKEN 环境变量${c.reset}`)
  process.exit(1)
}

/** 带管理员鉴权的请求；headerVariant 用于探不同鉴权头形态 */
async function call(method, path, { body, asUserId, headerVariant = 'bearer' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (headerVariant === 'bearer') headers['Authorization'] = `Bearer ${ADMIN}`
  if (headerVariant === 'raw') headers['Authorization'] = ADMIN
  if (headerVariant === 'cookie') headers['Cookie'] = `session=${ADMIN}`
  if (asUserId != null) headers['New-API-User'] = String(asUserId)
  const started = Date.now()
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    // New API 鉴权失败返回 HTTP 200 + {success:false}，不能只看 HTTP 状态码。
    const apiOk = json ? json.success !== false : resp.ok
    return { status: resp.status, ok: apiOk, json, raw: text.slice(0, 400), ms: Date.now() - started }
  } catch (e) {
    return { status: 0, ok: false, error: e.message, ms: Date.now() - started }
  }
}

function summarize(r) {
  if (r.error) return `${c.red}ERR ${r.error}${c.reset} (${r.ms}ms)`
  const color = r.ok ? c.green : c.yellow
  const shape = r.json ? JSON.stringify(r.json).slice(0, 300) : r.raw
  return `${color}HTTP ${r.status}${c.reset} (${r.ms}ms)\n    ${c.dim}${shape}${c.reset}`
}

async function main() {
  log(`${c.bold}New API 探针${c.reset}  base=${BASE}  admin=${mask(ADMIN)}  write=${WRITE}  QuotaPerUnit=${QUOTA_PER_UNIT}`)

  // ── 1. 探鉴权头格式：列用户列表，试 Bearer / raw / raw+New-API-User ──
  hr('1. admin 鉴权头格式（按 success 字段判定，非 HTTP 状态码）')
  const variants = [
    { label: 'Bearer + New-API-User:2', hv: 'bearer', uid: 2 },
    { label: 'raw + New-API-User:2', hv: 'raw', uid: 2 },
    { label: 'Bearer + New-API-User:1', hv: 'bearer', uid: 1 },
    { label: 'Bearer (无 New-API-User)', hv: 'bearer', uid: undefined },
  ]
  let authVariant = null
  let authUid = undefined
  for (const v of variants) {
    const r = await call('GET', '/api/user/?p=0&page_size=1', { headerVariant: v.hv, asUserId: v.uid })
    log(`  [${v.label}]  ${summarize(r)}`)
    if (r.ok && !authVariant) { authVariant = v.hv; authUid = v.uid }
  }
  if (!authVariant) {
    log(`  ${c.red}所有鉴权变体都失败 — 这个 token 不是 admin 管理接口的「系统访问令牌」。${c.reset}`)
    log(`  ${c.yellow}New API 后台 → 用户(admin/root) → 个人设置 → 生成系统访问令牌，配成 NEWAPI_ADMIN_TOKEN 才能调 /api/user/。${c.reset}`)
    log(`  ${c.dim}当前这个 sk- token 是 API 令牌（推理转发用），只能调 /v1/dashboard/billing/usage，调不了管理接口。${c.reset}`)
  } else {
    log(`  ${c.green}✓ 可用鉴权: ${authVariant}${authUid ? ' + New-API-User:' + authUid : ''}${c.reset}`)
  }
  const hv = authVariant || 'bearer'
  const adminUid = authUid

  // ── 2. 取一个真实用户看 quota 字段结构 ──
  hr('2. 用户 quota 字段结构（list 第一个 + /api/user/self）')
  const list = await call('GET', '/api/user/?p=0&page_size=3', { headerVariant: hv, asUserId: adminUid })
  log(`  [GET /api/user/]  ${summarize(list)}`)
  const firstUser = list.json?.data?.items?.[0] || list.json?.data?.[0] || (Array.isArray(list.json?.data) ? list.json.data[0] : null)
  if (firstUser) {
    const qf = Object.keys(firstUser).filter((k) => /quota|used|balance|group/i.test(k))
    log(`  ${c.green}quota 相关字段:${c.reset} ${qf.map((k) => `${k}=${firstUser[k]}`).join(', ') || '(无明显字段，看上面原始结构)'}`)
    log(`  ${c.dim}user.id=${firstUser.id}${c.reset}`)
  }
  const self = await call('GET', '/api/user/self', { headerVariant: hv, asUserId: adminUid })
  log(`  [GET /api/user/self]  ${summarize(self)}`)

  // ── 3. quota 单位换算确认 ──
  hr('3. quota 单位换算')
  const status = await call('GET', '/api/status', { headerVariant: hv })
  const qpu = status.json?.data?.quota_per_unit ?? status.json?.quota_per_unit
  log(`  /api/status quota_per_unit = ${qpu ?? '(未返回，需在 New API 后台确认)'}`)
  log(`  本地配置 NEWAPI_QUOTA_PER_UNIT = ${QUOTA_PER_UNIT} ${qpu != null && qpu !== QUOTA_PER_UNIT ? c.red + '✗ 不一致!' + c.reset : (qpu != null ? c.green + '✓ 一致' + c.reset : '')}`)

  // ── 4. 写操作（建用户 / 铸 token / 加额度）仅 --write ──
  hr('4. 写操作（建用户 / 铸 token / 加额度）')
  if (!WRITE) {
    log(`  ${c.yellow}跳过（只读模式）。确认上面只读结果无误后，加 --write 跑这一段。${c.reset}`)
    log(`  ${c.dim}--write 将：建测试用户 probe_<ts> → 尝试铸 token → 尝试 PUT 改 quota → 打印各步响应${c.reset}`)
    return
  }
  const username = `probe_${Date.now()}`
  log(`  建测试用户 username=${username}`)
  const created = await call('POST', '/api/user/', { headerVariant: hv, asUserId: adminUid, body: { username, password: `Pb!${Date.now()}`, display_name: 'probe' } })
  log(`  [POST /api/user/]  ${summarize(created)}`)
  // 建用户成功后需重新查列表拿新 id（CreateUser 常不回 id）
  let newId = created.json?.data?.id ?? created.json?.id
  if (newId == null && created.ok) {
    const find = await call('GET', `/api/user/search?keyword=${username}`, { headerVariant: hv, asUserId: adminUid })
    newId = find.json?.data?.items?.[0]?.id ?? find.json?.data?.[0]?.id
  }
  log(`  新用户 id = ${newId ?? '(未取到，看上面结构)'}`)

  if (newId != null) {
    // 加额度：PUT /api/user/ 改 quota（admin 身份）
    log(`  试 PUT /api/user/ 加额度 quota=${QUOTA_PER_UNIT}（=1 单位）`)
    const upd = await call('PUT', '/api/user/', { headerVariant: hv, asUserId: adminUid, body: { id: newId, quota: QUOTA_PER_UNIT } })
    log(`  [PUT /api/user/]  ${summarize(upd)}`)

    // 铸 token 关键测试：能否用 admin token + New-API-User=<新用户id> 替他铸 token
    log(`  试 POST /api/token/ 用 admin token + New-API-User=${newId} 替新用户铸 token`)
    const tok = await call('POST', '/api/token/', { headerVariant: hv, asUserId: newId, body: { name: 'profer-probe', remain_quota: -1, unlimited_quota: true } })
    log(`  [POST /api/token/ as newUser]  ${summarize(tok)}`)
    if (!tok.ok) {
      log(`  ${c.yellow}→ admin 不能替别人铸 token（New-Api-User 必须=token 所属者）。需走「为新用户单独建/存其 access_token，再以其身份铸」路线。${c.reset}`)
    }
    log(`  ${c.dim}测试用户 ${username}(id=${newId}) 已建，验证完用 DELETE /api/user/${newId} 清除。${c.reset}`)
    // 自动清理测试用户
    const del = await call('DELETE', `/api/user/${newId}`, { headerVariant: hv, asUserId: adminUid })
    log(`  [DELETE /api/user/${newId}]  ${summarize(del)} ${del.ok ? c.green + '✓ 测试用户已清除' + c.reset : c.red + '清除失败，请手动删' + c.reset}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
