import { Hono } from 'hono'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { db, ensureCreditRow, getUserByEmail } from '../db.js'
import { JWT_SECRET, JWT_EXPIRES, ACCESS_TOKEN_EXPIRES, MAX_LOGIN_ATTEMPTS, ACCOUNT_LOCK_MINUTES, COMMERCIAL_MODE } from '../config.js'
import { hashPassword, verifyPassword, validatePassword, validateEmail } from '../utils.js'
import { rateLimit } from '../rate-limiter.js'
import { logAudit } from '../audit.js'
import { hashToken } from '../middleware.js'

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

function clientIP(c) {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return c.env?.remoteAddr || c.req.header('x-real-ip') || 'unknown'
}

// ===== 注册 =====
authRoutes.post('/register', async (c) => {
  const rl = rateLimit(`register:${clientIP(c)}`, 5 * 60 * 1000, 10)
  if (!rl.allowed) {
    return c.json({ error: `请求过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试` }, 429)
  }

  const body = await c.req.json()
  const { email, password, displayName, invitationToken } = body || {}

  const emailErr = validateEmail(email)
  if (emailErr) return c.json({ error: emailErr }, 400)
  const pwdErr = validatePassword(password)
  if (pwdErr) return c.json({ error: pwdErr }, 400)

  if (!invitationToken) return c.json({ error: '需要有效的邀请链接或邀请码才能注册' }, 400)

  const inv = db.prepare(`
    SELECT i.*, w.name as workspace_name FROM invitations i
    JOIN workspaces w ON i.workspace_id = w.id
    WHERE i.token = ?
  `).get(invitationToken)

  if (!inv) return c.json({ error: '邀请码无效' }, 400)
  if (inv.status !== 'pending') return c.json({ error: '邀请码已被使用' }, 410)
  if (inv.expires_at < Date.now()) return c.json({ error: '邀请码已过期' }, 410)

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    if (inv?.workspace_id) {
      // 检查是否已是该工作区成员
      const isMember = db.prepare(
        'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(inv.workspace_id, existing.id)
      if (isMember) {
        return c.json({ error: '你已是该工作区成员，请直接登录' }, 409)
      }
      return c.json({
        error: '该邮箱已注册，请登录后使用「通过邀请码加入」功能',
        alreadyRegistered: true,
        workspaceName: inv.workspace_name,
      }, 409)
    }
    return c.json({ error: '该邮箱已注册，请直接登录' }, 409)
  }

  const id = uuidv4()
  const now = Date.now()

  // 独立的 refreshToken
  const refreshToken = uuidv4() + '.' + uuidv4()

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, refresh_token, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, email, hashPassword(password), displayName || email.split('@')[0], refreshToken, now)

    db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(inv.workspace_id, id, inv.role, now)

    db.prepare(
      'UPDATE invitations SET status = ? WHERE id = ?'
    ).run('accepted', inv.id)
  })
  tx()

  const accessToken = jwt.sign({ sub: id, email, is_admin: false, commercial_mode: COMMERCIAL_MODE }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  const tokenExpiresAt = now + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000
  ensureCreditRow(id)
	  logAudit({ action: 'register', workspaceId: inv.workspace_id, userId: id, userEmail: email, entityType: 'workspace', entityId: inv.workspace_id, detail: `joined workspace: ${inv.workspace_name}` })
  return c.json({
    accessToken,
    refreshToken,
    expiresAt: tokenExpiresAt,
    userId: id,
    email,
    commercialMode: COMMERCIAL_MODE,
    joinedWorkspace: inv.workspace_name,
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

  // 生成新的 refreshToken，旧 refreshToken 自动失效
  const refreshToken = uuidv4() + '.' + uuidv4()
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  db.prepare('UPDATE users SET refresh_token = ? WHERE id = ?').run(refreshToken, user.id)
  logAudit({ action: 'login', userId: user.id, userEmail: user.email })

  return c.json({
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
    userId: user.id,
    email: user.email,
    isAdmin: !!user.is_admin,
    commercialMode: COMMERCIAL_MODE,
  })
})

// ===== 刷新 accessToken =====
authRoutes.post('/refresh', async (c) => {
  const { refreshToken } = await c.req.json()
  if (!refreshToken) return c.json({ error: 'refreshToken 必填' }, 400)

  const user = db.prepare('SELECT id, email, is_admin FROM users WHERE refresh_token = ?').get(refreshToken)
  if (!user) return c.json({ error: 'refreshToken 无效或已被替换' }, 401)

  // 检查账户锁定（refresh 期间也能感知）
  const locked = db.prepare('SELECT locked_until FROM users WHERE id = ?').get(user.id)
  if (locked?.locked_until && locked.locked_until > Date.now()) {
    return c.json({ error: '账户已锁定' }, 423)
  }

  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  return c.json({
    accessToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
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
  logAudit({ action: 'logout', userId: payload.sub, userEmail: payload.email })

  return c.json({ success: true })
})
