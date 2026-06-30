import { Hono } from 'hono'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { db, ensureCreditRow, getUserByEmail, ensureRelayToken, rotateRelayToken, validateActivationCode } from '../db.js'
import { JWT_SECRET, JWT_EXPIRES, ACCESS_TOKEN_EXPIRES, MAX_LOGIN_ATTEMPTS, ACCOUNT_LOCK_MINUTES, COMMERCIAL_MODE, getAccountCapability } from '../config.js'
import { hashPassword, verifyPassword, validatePassword, validateEmail, clientIP } from '../utils.js'
import { rateLimit } from '../rate-limiter.js'
import { logAudit } from '../audit.js'
import { hashToken } from '../middleware.js'

/** 生成加密安全的 refresh token（256 位熵） */
function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** 解析 JWT expiresIn 字符串为秒数 */
function expiresInSeconds(expiresIn) {
  if (typeof expiresIn === 'number') return expiresIn
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(expiresIn)
  if (!m) return 3600
  const v = parseInt(m[1], 10)
  switch (m[2]) {
    case 's': return v
    case 'm': return v * 60
    case 'h': return v * 3600
    case 'd': return v * 86400
    default: return 3600
  }
}

export const authRoutes = new Hono()

// ===== 注册 =====
// 支持两种方式：
//   邀请码 (invitationToken) → 绑定工作区，account_type 默认 standard
//   激活码 (activationCode)  → 不绑定工作区，account_type 从激活码取
//
//   当前端同时传 invitationToken + activationCode（同一值）时：
//   优先尝试邀请码 → 回退尝试激活码 → 两个都无效才报错
authRoutes.post('/register', async (c) => {
  const rl = rateLimit(`register:${clientIP(c)}`, 5 * 60 * 1000, 10)
  if (!rl.allowed) {
    return c.json({ error: `请求过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试` }, 429)
  }

  const body = await c.req.json()
  const { email, password, displayName, invitationToken, activationCode } = body || {}

  const emailErr = validateEmail(email)
  if (emailErr) return c.json({ error: emailErr }, 400)
  const pwdErr = validatePassword(password)
  if (pwdErr) return c.json({ error: pwdErr }, 400)

  if (!invitationToken && !activationCode) {
    return c.json({ error: '需要邀请码或激活码才能注册' }, 400)
  }

  // 检查邮箱是否已注册
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    return c.json({ error: '该邮箱已注册，请直接登录', alreadyRegistered: true }, 409)
  }

  let accountType = 'standard'
  let workspaceName = ''
  let workspaceId = ''

  // ---- 分支 A：邀请码优先（处理 invitationToken + activationCode 同值场景）----
  if (invitationToken) {
    const inv = db.prepare(`
      SELECT i.*, w.name as workspace_name FROM invitations i
      JOIN workspaces w ON i.workspace_id = w.id
      WHERE i.token = ?
    `).get(invitationToken)

    if (inv && inv.status === 'pending' && inv.expires_at >= Date.now()) {
      // ✅ 是有效邀请码
      workspaceId = inv.workspace_id
      workspaceName = inv.workspace_name
    } else if (inv) {
      // 邀请码存在但状态不对
      if (inv.status !== 'pending') return c.json({ error: '邀请码已被使用' }, 410)
      if (inv.expires_at < Date.now()) return c.json({ error: '邀请码已过期' }, 410)
    } else if (activationCode) {
      // invitationToken 不是有效邀请码，回退尝试作为激活码
      const ac = validateActivationCode(activationCode)
      if (!ac.valid) return c.json({ error: ac.error }, 400)
      accountType = ac.accountType || 'standard'
      // 标记激活码已使用
      db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ?")
        .run(email, Date.now(), activationCode)
    } else {
      return c.json({ error: '邀请码无效' }, 400)
    }
  }
  // ---- 分支 B：仅激活码注册（没有 invitationToken 但有 activationCode）----
  else if (activationCode) {
    const ac = validateActivationCode(activationCode)
    if (!ac.valid) return c.json({ error: ac.error }, 400)
    accountType = ac.accountType || 'standard'
    // 标记激活码已使用
    db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ?")
      .run(email, Date.now(), activationCode)
  }

  const id = uuidv4()
  const now = Date.now()
  const refreshToken = generateRefreshToken()

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, refresh_token, account_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, email, hashPassword(password), displayName || email.split('@')[0], refreshToken, accountType, now)

    // 仅邀请码注册加入工作区
    if (workspaceId) {
      db.prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
      ).run(workspaceId, id, 'member', now)

      db.prepare(
        'UPDATE invitations SET status = ? WHERE token = ?'
      ).run('accepted', invitationToken)
    }
  })
  tx()

  ensureCreditRow(id, accountType)
  logAudit({ action: 'register', workspaceId: workspaceId || undefined, userId: id, userEmail: email, detail: workspaceName ? `joined: ${workspaceName}` : `type: ${accountType}` })

  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(id) : undefined

  const accessToken = jwt.sign({ sub: id, email, is_admin: false, commercial_mode: COMMERCIAL_MODE, account_type: accountType }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  const tokenExpiresAt = now + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000
  return c.json({
    accessToken, refreshToken, expiresAt: tokenExpiresAt, relayToken,
    userId: id, email, displayName: displayName || email.split('@')[0],
    commercialMode: COMMERCIAL_MODE, accountType,
    canSelfConfigApi: false, joinedWorkspace: workspaceName || undefined,
  })
})

// ===== 登录 =====
authRoutes.post('/login', async (c) => {
  const rl = rateLimit(`login:${clientIP(c)}`, 60 * 1000, 5)
  if (!rl.allowed) {
    return c.json({ error: `登录尝试过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试` }, 429)
  }

  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: '邮箱和密码必填' }, 400)

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user) {
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  // 检查账户锁定
  if (user.locked_until && user.locked_until > Date.now()) {
    const remaining = Math.max(1, Math.ceil((user.locked_until - Date.now()) / 60000))
    return c.json({ error: `账户已锁定，请 ${remaining} 分钟后重试` }, 423)
  }

  if (user.is_suspended) {
    return c.json({ error: '账号已被停用，请联系管理员' }, 403)
  }

  if (!verifyPassword(password, user.password_hash)) {
    // 记录失败
    const attempts = (user.failed_login_attempts || 0) + 1
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?')
        .run(Date.now() + ACCOUNT_LOCK_MINUTES * 60 * 1000, user.id)
      return c.json({ error: `密码错误次数过多，账户已锁定 ${ACCOUNT_LOCK_MINUTES} 分钟` }, 423)
    }
    db.prepare('UPDATE users SET failed_login_attempts = ? WHERE id = ?').run(attempts, user.id)
    return c.json({ error: '邮箱或密码错误' }, 401)
  }

  // 登录成功，重置失败计数
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id)
  ensureCreditRow(user.id)

  // 生成新的 refreshToken，旧 refreshToken 自动失效
  const refreshToken = generateRefreshToken()
  const accountType = user.account_type || 'standard'
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE, account_type: accountType }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refreshToken, user.id)
  logAudit({ action: 'login', userId: user.id, userEmail: user.email })

  // 代管模式下签发长效 relay 令牌
  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(user.id) : undefined

  return c.json({
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
    relayToken,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
    commercialMode: COMMERCIAL_MODE,
    accountType,
    canSelfConfigApi: !!user.can_self_config_api,
  })
})

// ===== 刷新 accessToken =====
authRoutes.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json()
  if (!refreshToken) return c.json({ error: 'refreshToken 必填' }, 400)

  const user = db.prepare('SELECT id, email, display_name, account_type, is_admin, is_suspended FROM users WHERE refresh_token = ?').get(refreshToken)
  if (!user) return c.json({ error: 'refreshToken 无效或已被替换' }, 401)

  if (user.is_suspended) {
    return c.json({ error: '账号已被停用，请重新登录或联系管理员' }, 403)
  }

  // 检查账户锁定（refresh 期间也能感知）
  const locked = db.prepare('SELECT locked_until FROM users WHERE id = ?').get(user.id)
  if (locked?.locked_until && locked.locked_until > Date.now()) {
    return c.json({ error: '账户已锁定' }, 423)
  }

  ensureCreditRow(user.id)

  const accountType = user.account_type || 'standard'
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE, account_type: accountType }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })

  // 代管模式下回带 relay 令牌，确保客户端始终持有（幂等，不存在则生成）
  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(user.id) : undefined

  // refresh 时重新读取 DB 里的 account_type 和 can_self_config_api，
  // 确保管理员改类型后下次 refresh 即生效（不超 1h）
  return c.json({
    accessToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
    relayToken,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
    commercialMode: COMMERCIAL_MODE,
    accountType,
    canSelfConfigApi: !!user.can_self_config_api,
  })
})

// ===== 登出 =====
authRoutes.post('/logout', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: '未提供认证令牌' }, 401)

  const token = auth.slice(7)
  let payload
  try {
    payload = jwt.verify(token, JWT_SECRET)
  } catch {
    return c.json({ success: true }) // token 已过期也算登出成功
  }

  // 加入黑名单
  const h = hashToken(token)
  db.prepare('INSERT OR IGNORE INTO token_blacklist (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
    .run(h, payload.exp * 1000, Date.now())

  // 清除 refreshToken，强制重新登录
  db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(payload.sub)

  // 吊销 relay 令牌：登出后旧令牌立即失效，防止本地残留令牌继续打 proxy 扣费。
  // 下次登录时 ensureRelayToken 会签发新令牌。
  if (COMMERCIAL_MODE) {
    try { rotateRelayToken(payload.sub) } catch (e) { console.warn('[logout] 吊销 relay 令牌失败:', e.message) }
  }

  logAudit({ action: 'logout', userId: payload.sub, userEmail: payload.email })

  return c.json({ success: true })
})
