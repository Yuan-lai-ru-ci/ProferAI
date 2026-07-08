import { Hono } from 'hono'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { db, ensureCreditRow, getUserByEmail, ensureRelayToken, rotateRelayToken, validateActivationCode } from '../db.js'
import { JWT_SECRET, JWT_EXPIRES, ACCESS_TOKEN_EXPIRES, MAX_LOGIN_ATTEMPTS, ACCOUNT_LOCK_MINUTES, COMMERCIAL_MODE, getAccountCapability } from '../config.js'
import { hashPassword, verifyPassword, validatePassword, validateEmail, clientIP } from '../utils.js'
import { rateLimit } from '../rate-limiter.js'
import { logAudit } from '../audit.js'
import { hashToken, authMiddleware } from '../middleware.js'

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

/** 列出用户的登录设备（设备管理页 + 超限提示用） */
function listUserDevices(userId) {
  return db.prepare(
    `SELECT id, device_id, device_name, platform, app_version, created_at, last_used_at
     FROM refresh_tokens WHERE user_id = ? ORDER BY last_used_at DESC`
  ).all(userId).map((r) => ({
    id: r.id,
    deviceId: r.device_id || null,
    deviceName: r.device_name || '未命名设备',
    platform: r.platform || null,
    appVersion: r.app_version || null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }))
}

/**
 * 登记设备的 refresh token（注册设备数模型）。
 * - 带 deviceId：同设备复用同一行（换发新 token），不再吃新槽位；
 *   新设备且已满额 → 返回 { ok:false, devices } 由调用方回 409 让用户显式撤销。
 * - 无 deviceId（老客户端）：沿用 LRU，最多 maxDevices，超出删最旧，保证向后兼容。
 */
function registerDeviceToken(userId, refreshToken, meta) {
  const { deviceId, deviceName, platform, appVersion, maxDevices } = meta
  const now = Date.now()
  if (deviceId) {
    const existing = db.prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND device_id = ?').get(userId, deviceId)
    if (existing) {
      db.prepare('UPDATE refresh_tokens SET token = ?, device_name = ?, platform = ?, app_version = ?, last_used_at = ? WHERE id = ?')
        .run(refreshToken, deviceName || null, platform || null, appVersion || null, now, existing.id)
      return { ok: true }
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ?').get(userId).c
    if (count >= maxDevices) {
      return { ok: false, maxDevices, devices: listUserDevices(userId) }
    }
    db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_id, device_name, platform, app_version, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), userId, refreshToken, deviceId, deviceName || null, platform || null, appVersion || null, now, now)
    return { ok: true }
  }
  // 老客户端无 deviceId：LRU 淘汰最旧
  const count = db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ?').get(userId).c
  if (count >= maxDevices) {
    db.prepare('DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY last_used_at ASC LIMIT ?)')
      .run(userId, count - maxDevices + 1)
  }
  db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), userId, refreshToken, deviceName || null, now, now)
  return { ok: true }
}

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
  const { email, password, displayName, invitationToken, activationCode, deviceId, deviceName, platform, appVersion } = body || {}

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

    // 登记设备（注册时必然是首台设备，不会触发上限）
    registerDeviceToken(id, refreshToken, {
      deviceId, deviceName, platform, appVersion,
      maxDevices: getAccountCapability(accountType).maxDevices,
    })

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
    userId: id, teamAccountId: id, teamEmail: email,
    email, displayName: displayName || email.split('@')[0],
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

  const { email, password, deviceId, deviceName, platform, appVersion, revokeSlotId } = await c.req.json()
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

  // 生成新的 refreshToken，写入独立表（支持多设备同时在线，最多 3 台）
  const refreshToken = generateRefreshToken()
  const accountType = user.account_type || 'standard'
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE, account_type: accountType }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })

  // 可选：先撤销一台设备（用户在上限 409 的设备列表里选的），必须属于本人
  if (revokeSlotId) {
    db.prepare('DELETE FROM refresh_tokens WHERE id = ? AND user_id = ?').run(revokeSlotId, user.id)
  }

  // 登记设备（注册设备数模型）：同设备复用槽位不 churn；新设备满额则 409 让用户显式撤销
  const reg = registerDeviceToken(user.id, refreshToken, {
    deviceId, deviceName, platform, appVersion,
    maxDevices: getAccountCapability(accountType).maxDevices,
  })
  if (!reg.ok) {
    return c.json({
      error: `已达设备上限（最多 ${reg.maxDevices} 台）。请登出一台设备后重试。`,
      code: 'device_limit',
      maxDevices: reg.maxDevices,
      devices: reg.devices,
    }, 409)
  }
  logAudit({ action: 'login', userId: user.id, userEmail: user.email })

  // 代管模式下签发长效 relay 令牌
  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(user.id) : undefined

  return c.json({
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
    relayToken,
    userId: user.id,
    teamAccountId: user.id,
    teamEmail: user.email,
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
  const { refreshToken, deviceId, deviceName, platform, appVersion } = await c.req.json()
  if (!refreshToken) return c.json({ error: 'refreshToken 必填' }, 400)

  // 从多设备 refresh_tokens 表查找（向后兼容旧的 users.refresh_token）
  const tokenRow = db.prepare('SELECT id, user_id, device_id FROM refresh_tokens WHERE token = ?').get(refreshToken)
  const user = tokenRow
    ? db.prepare('SELECT id, email, display_name, account_type, is_admin, is_suspended, can_self_config_api FROM users WHERE id = ?').get(tokenRow.user_id)
    : db.prepare('SELECT id, email, display_name, account_type, is_admin, is_suspended, can_self_config_api FROM users WHERE refresh_token = ?').get(refreshToken)
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

  // 轮换 refreshToken：更新 refresh_tokens 表中的记录
  const newRefreshToken = generateRefreshToken()
  if (tokenRow) {
    // 存量迁移 + 元数据回填：老行 device_id 为空则补上（同账号无冲突时），同时轮换 token
    const canBackfill = deviceId && !tokenRow.device_id &&
      !db.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND id != ?').get(user.id, deviceId, tokenRow.id)
    db.prepare(
      `UPDATE refresh_tokens
       SET token = ?, last_used_at = ?,
           device_id = COALESCE(device_id, ?),
           device_name = COALESCE(?, device_name),
           platform = COALESCE(?, platform),
           app_version = COALESCE(?, app_version)
       WHERE id = ?`
    ).run(newRefreshToken, Date.now(), canBackfill ? deviceId : null, deviceName || null, platform || null, appVersion || null, tokenRow.id)
  } else {
    // 从旧 users.refresh_token 迁移到新表（带上设备信息；device_id 冲突时置空避免撞唯一索引）
    const deviceIdSafe = deviceId && !db.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ? AND device_id = ?').get(user.id, deviceId) ? deviceId : null
    db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_id, device_name, platform, app_version, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), user.id, newRefreshToken, deviceIdSafe, deviceName || null, platform || null, appVersion || null, Date.now(), Date.now())
    db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(user.id)
  }

  // 代管模式下回带 relay 令牌，确保客户端始终持有（幂等，不存在则生成）
  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(user.id) : undefined

  // refresh 时重新读取 DB 里的 account_type 和 can_self_config_api，
  // 确保管理员改类型后下次 refresh 即生效（不超 1h）
  return c.json({
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: Date.now() + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000,
    relayToken,
    userId: user.id,
    teamAccountId: user.id,
    teamEmail: user.email,
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

  const { deviceId, refreshToken } = (await c.req.json().catch(() => ({}))) || {}
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

  // 释放当前设备的登录槽位（新模型：登出即腾出设备名额，不残留僵尸槽）
  if (deviceId) {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?').run(payload.sub, deviceId)
  } else if (refreshToken) {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND token = ?').run(payload.sub, refreshToken)
  }
  // 清除旧 users.refresh_token（legacy 单 token 字段）
  db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(payload.sub)

  // 吊销 relay 令牌：登出后旧令牌立即失效，防止本地残留令牌继续打 proxy 扣费。
  // 下次登录时 ensureRelayToken 会签发新令牌。
  if (COMMERCIAL_MODE) {
    try { rotateRelayToken(payload.sub) } catch (e) { console.warn('[logout] 吊销 relay 令牌失败:', e.message) }
  }

  logAudit({ action: 'logout', userId: payload.sub, userEmail: payload.email })

  return c.json({ success: true })
})

// ===== 设备管理（注册设备数模型）=====
// 列出当前账号的登录设备。需 JWT 鉴权。
authRoutes.get('/devices', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  return c.json({ devices: listUserDevices(c.get('userId')) })
})

// 撤销（登出）指定设备槽位。需 JWT 鉴权，且该槽位必须属于当前账号。
// 登录被设备上限挡住（尚无 accessToken）时，改用 POST /login 带 revokeSlotId 撤销。
authRoutes.delete('/devices/:id', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  const userId = c.get('userId')
  const rowId = c.req.param('id')
  const row = db.prepare('SELECT id FROM refresh_tokens WHERE id = ? AND user_id = ?').get(rowId, userId)
  if (!row) return c.json({ error: '设备不存在或无权操作' }, 404)
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(rowId)
  logAudit({ action: 'device_revoke', userId, userEmail: c.get('userEmail'), detail: `revoked device slot ${rowId}` })
  return c.json({ ok: true })
})
