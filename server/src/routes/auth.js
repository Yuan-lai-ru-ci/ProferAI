import { Hono } from 'hono'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { db, ensureCreditRow, getUserByEmail, ensureRelayToken, rotateRelayToken, validateActivationCode, createInviteCode, getInviterByCode, recordInviteEvent } from '../db.js'
import { JWT_SECRET, JWT_EXPIRES, ACCESS_TOKEN_EXPIRES, MAX_LOGIN_ATTEMPTS, ACCOUNT_LOCK_MINUTES, COMMERCIAL_MODE, PER_USER_NEWAPI_KEY, NEWAPI_USER_INITIAL_QUOTA, getSubscriptionCap } from '../config.js'
import { hashPassword, verifyPassword, validatePassword, validateEmail, clientIP } from '../utils.js'
import { rateLimit } from '../rate-limiter.js'
import { logAudit } from '../audit.js'
import { authMiddleware } from '../middleware.js'
import { hashToken } from '../utils.js'
import { createNewApiUser, generateNewApiToken, provisionNewApiUser } from '../newapi-client.js'

/** 生成加密安全的 refresh token（256 位熵） */
function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** refresh token 有效期（30 天，滑动续期） */
const REFRESH_TOKEN_TTL_MS = 30 * 86400 * 1000

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
  const expiresAt = now + REFRESH_TOKEN_TTL_MS
  // 库中只存哈希（防库泄后反推）；明文仅存在于响应与内存。
  const storedToken = hashToken(refreshToken)
  const isWeb = platform === 'web'
  if (deviceId) {
    const existing = db.prepare('SELECT id FROM refresh_tokens WHERE user_id = ? AND device_id = ?').get(userId, deviceId)
    if (existing) {
      db.prepare('UPDATE refresh_tokens SET token = ?, device_name = ?, platform = ?, app_version = ?, last_used_at = ?, expires_at = ? WHERE id = ?')
        .run(storedToken, deviceName || null, platform || null, appVersion || null, now, expiresAt, existing.id)
      return { ok: true }
    }
    // Web 端登录不占设备槽位，跳过数量检查
    if (!isWeb) {
      const count = db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ? AND (platform IS NULL OR platform != ?)').get(userId, 'web').c
      if (count >= maxDevices) {
        return { ok: false, maxDevices, devices: listUserDevices(userId) }
      }
    }
    db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_id, device_name, platform, app_version, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), userId, storedToken, deviceId, deviceName || null, platform || null, appVersion || null, now, now, expiresAt)
    return { ok: true }
  }
  // 老客户端无 deviceId：LRU 淘汰最旧
  const count = db.prepare('SELECT COUNT(*) as c FROM refresh_tokens WHERE user_id = ?').get(userId).c
  if (count >= maxDevices) {
    db.prepare('DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY last_used_at ASC LIMIT ?)')
      .run(userId, count - maxDevices + 1)
  }
  db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_name, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), userId, storedToken, deviceName || null, now, now, expiresAt)
  return { ok: true }
}

// ===== 注册 =====
// 邀请码制（inviteCode）为主入口，需填写已有用户的邀请码才能注册。
// activationCode 保留为管理员后门（直接开号，不走邀请链路）。
// invitationToken 为工作区邀请（加入已有团队），可选。
authRoutes.post('/register', async (c) => {
  const rl = rateLimit(`register:${clientIP(c)}`, 5 * 60 * 1000, 10)
  if (!rl.allowed) {
    return c.json({ error: `请求过于频繁，请 ${Math.ceil(rl.retryAfterMs / 1000)} 秒后重试` }, 429)
  }

  const body = await c.req.json()
  const { email, password, displayName, inviteCode, activationCode, invitationToken, deviceId, deviceName, platform, appVersion } = body || {}

  const emailErr = validateEmail(email)
  if (emailErr) return c.json({ error: emailErr }, 400)
  const pwdErr = validatePassword(password)
  if (pwdErr) return c.json({ error: pwdErr }, 400)

  // 检查邮箱是否已注册
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
  if (existing) {
    return c.json({ error: '该邮箱已注册，请直接登录', alreadyRegistered: true }, 409)
  }

  let membershipTier = 'free'
  let workspaceName = ''
  let workspaceId = ''
  let inviterId = null

  // ---- 分支 A：激活码注册（管理员后门，无需邀请码）----
  if (activationCode && !inviteCode) {
    const ac = validateActivationCode(activationCode)
    if (!ac.valid) return c.json({ error: ac.error }, 400)
    membershipTier = ac.membershipTier || 'free'
    // 原子消费：带 status='pending' 条件 + 检查 changes，防并发双花
    const consumed = db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending'")
      .run(email, Date.now(), activationCode)
    if (consumed.changes === 0) return c.json({ error: '激活码已被使用' }, 400)
  }
  // ---- 分支 B：邀请码注册（主入口）----
  // 先查邀请码，查不到则 fallback 尝试激活码（管理员后台生成的码也能走注册 UI）
  else if (inviteCode) {
    const inviter = getInviterByCode(inviteCode)
    if (inviter) {
      inviterId = inviter.user_id
    } else {
      // fallback：作为激活码校验
      const ac = validateActivationCode(inviteCode)
      if (!ac.valid) return c.json({ error: ac.error || '邀请码无效' }, 400)
      membershipTier = ac.membershipTier || 'free'
      const consumed = db.prepare("UPDATE activation_codes SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending'")
        .run(email, Date.now(), inviteCode)
      if (consumed.changes === 0) return c.json({ error: ac.error || '激活码已被使用' }, 400)
    }
  }
  // ---- 必须提供 inviteCode 或 activationCode ----
  else {
    return c.json({ error: '需要邀请码才能注册' }, 400)
  }

  // ---- 可选：工作区邀请（加入已有团队）----
  if (invitationToken) {
    const inv = db.prepare(`
      SELECT i.*, w.name as workspace_name FROM invitations i
      JOIN workspaces w ON i.workspace_id = w.id
      WHERE i.token = ?
    `).get(invitationToken)
    if (inv && inv.status === 'pending' && inv.expires_at >= Date.now()) {
      workspaceId = inv.workspace_id
      workspaceName = inv.workspace_name
    }
    // 工作区邀请失败不阻塞注册
  }

  const id = uuidv4()
  const now = Date.now()
  const refreshToken = generateRefreshToken()

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, refresh_token, membership_tier, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, email, hashPassword(password), displayName || email.split('@')[0], refreshToken, membershipTier, inviterId, now)

    // 登记设备（注册时必然是首台设备）
    registerDeviceToken(id, refreshToken, {
      deviceId, deviceName, platform, appVersion,
      maxDevices: getSubscriptionCap(membershipTier).maxDevices,
    })

    // 生成本人的邀请码
    createInviteCode(id)

    // 记录邀请事件
    if (inviterId) {
      recordInviteEvent({ inviterId, inviteeId: id, event: 'register' })
    }

    // 加入工作区（如有工作区邀请）
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

  ensureCreditRow(id)
  logAudit({ action: 'register', workspaceId: workspaceId || undefined, userId: id, userEmail: email, detail: `${workspaceName ? `joined: ${workspaceName}` : ''} invited_by: ${inviterId || 'activation_code'}` })

  // New API 创建用户 + API Key
  if (COMMERCIAL_MODE) {
    if (PER_USER_NEWAPI_KEY) {
      // 每用户独立 Key：同步创建，失败阻塞注册
      const r = await provisionNewApiUser(email, displayName || email.split('@')[0], NEWAPI_USER_INITIAL_QUOTA)
      if (!r.ok) {
        console.error(`[register] New API 账号创建失败 (user=${email}): ${r.error}`)
        // 补偿删除本事务已写入的数据，避免半注册僵尸账号堆积（用户看到 503，但账号实际已建）。
        // 必须按外键依赖顺序删除：credit_transactions/credits 先于 users（ensureCreditRow 已写入）。
        try {
          db.prepare('DELETE FROM credit_transactions WHERE user_id = ?').run(id)
          db.prepare('DELETE FROM credits WHERE user_id = ?').run(id)
          db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id)
          db.prepare('DELETE FROM invite_codes WHERE user_id = ?').run(id)
          db.prepare('DELETE FROM invite_records WHERE invitee_id = ?').run(id)
          db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(id)
          db.prepare('DELETE FROM users WHERE id = ?').run(id)
        } catch (cleanupError) {
          console.error(`[register] 补偿删除半注册用户失败 (user=${email}): ${cleanupError.message}`)
        }
        logAudit({ action: 'register_failed', userEmail: email, detail: `newapi provision failed: ${r.error}` })
        return c.json({ error: '服务暂时不可用，请稍后重试' }, 503)
      }
      db.prepare('UPDATE users SET new_api_user_id = ?, new_api_key_encrypted = ? WHERE id = ?')
        .run(r.userId, r.tokenKey, id)
    } else {
      // 旧方案：异步 fire-and-forget，不阻塞注册（未启用独立 Key 时的存量兼容路径）
      createNewApiUser(email, displayName || email.split('@')[0]).then(async (r) => {
        if (r.ok) {
          db.prepare('UPDATE users SET new_api_user_id = ? WHERE id = ?').run(r.userId, id)
          const tk = await generateNewApiToken(r.userId)
          if (tk.ok) {
            db.prepare('UPDATE users SET new_api_key_encrypted = ? WHERE id = ?').run(tk.key, id)
          } else {
            console.warn(`[register] New API Token 生成失败 (user=${email}, newApiId=${r.userId}): ${tk.error}`)
          }
        } else {
          console.warn(`[register] New API 用户创建失败 (user=${email}): ${r.error}`)
        }
      })
    }
  }

  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(id) : undefined

  const accessToken = jwt.sign({ sub: id, email, is_admin: false, commercial_mode: COMMERCIAL_MODE, membership_tier: membershipTier }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })
  const tokenExpiresAt = now + expiresInSeconds(ACCESS_TOKEN_EXPIRES) * 1000
  const myInviteCode = db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(id)?.code || ''

  return c.json({
    accessToken, refreshToken, expiresAt: tokenExpiresAt, relayToken,
    userId: id, teamAccountId: id, teamEmail: email,
    email, displayName: displayName || email.split('@')[0],
    commercialMode: COMMERCIAL_MODE, membershipTier,
    canSelfConfigApi: getSubscriptionCap(membershipTier).canSelfConfig || false,
    joinedWorkspace: workspaceName || undefined,
    // 会员 & 积分
    isVip: false, multiplier: 1.0,
    inviteCode: myInviteCode,
    balancePackage: 0, balanceReferral: 0, balancePurchased: 0,
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

  // 老账号补建邀请码（注册时可能还没有邀请码系统）
  try { createInviteCode(user.id) } catch (e) { console.warn('[login] 补建邀请码失败:', e.message) }

  // 存量用户补建 New API 账号（登录时检查，无独立 Key 则补建）
  if (COMMERCIAL_MODE && PER_USER_NEWAPI_KEY && !user.new_api_key_encrypted) {
    try {
      const r = await provisionNewApiUser(user.email, user.display_name, NEWAPI_USER_INITIAL_QUOTA)
      if (r.ok) {
        db.prepare('UPDATE users SET new_api_user_id = ?, new_api_key_encrypted = ? WHERE id = ?')
          .run(r.userId, r.tokenKey, user.id)
        console.log(`[login] 已为存量用户补建 New API 账号 (user=${user.email}, newApiId=${r.userId})`)
      } else {
        console.warn(`[login] 补建 New API 账号失败 (user=${user.email}): ${r.error}`)
      }
    } catch (e) {
      console.warn(`[login] 补建 New API 账号异常 (user=${user.email}): ${e.message}`)
    }
  }

  // 生成新的 refreshToken，写入独立表（支持多设备同时在线）
  const refreshToken = generateRefreshToken()
  const membershipTier = user.membership_tier || 'free'
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE, membership_tier: membershipTier }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })

  // 可选：先撤销一台设备（用户在上限 409 的设备列表里选的），必须属于本人。
  // 撤销设备即视为安全事件：同步轮换 relay 令牌，防止旧令牌继续打 proxy 扣费。
  if (revokeSlotId) {
    const slot = db.prepare('SELECT id FROM refresh_tokens WHERE id = ? AND user_id = ?').get(revokeSlotId, user.id)
    if (slot) {
      db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(revokeSlotId)
      if (COMMERCIAL_MODE) {
        try { rotateRelayToken(user.id) } catch (e) { console.warn('[login revokeSlotId] 吊销 relay 令牌失败:', e.message) }
      }
      logAudit({ action: 'device_revoke', userId: user.id, userEmail: user.email, detail: `revoked device slot ${revokeSlotId} via login` })
    }
  }

  // 登记设备（注册设备数模型）：同设备复用槽位不 churn；新设备满额则 409 让用户显式撤销
  const reg = registerDeviceToken(user.id, refreshToken, {
    deviceId, deviceName, platform, appVersion,
    maxDevices: getSubscriptionCap(membershipTier).maxDevices,
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
    membershipTier,
    canSelfConfigApi: getSubscriptionCap(membershipTier).canSelfConfig || false,
    // 会员 & 积分
    isVip: !!user.is_vip,
    multiplier: user.multiplier || 1.0,
    inviteCode: db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(user.id)?.code || '',
    balancePackage: user.balance_package || 0,
    balanceReferral: user.balance_referral || 0,
    balancePurchased: user.balance_purchased || 0,
  })
})

// ===== 刷新 accessToken =====
authRoutes.post('/refresh', async (c) => {
  // 无效 token 也可无限打 DB；按 IP 限流，防爆破/放大（配合原子轮换后无效 token 直接 401）
  const rl = rateLimit(`refresh:${clientIP(c)}`, 60 * 1000, 30)
  if (!rl.allowed) return c.json({ error: '请求过于频繁，请稍后重试' }, 429)

  const { refreshToken, deviceId, deviceName, platform, appVersion } = await c.req.json()
  if (!refreshToken) return c.json({ error: 'refreshToken 必填' }, 400)

  // 从多设备 refresh_tokens 表查找（向后兼容旧的 users.refresh_token）
  // 2026-08-08 哈希化：库中存 hashToken(明文)，查询用 IN (hash, plain) 兼容存量明文行。
  const tokenRow = db.prepare('SELECT id, user_id, device_id, expires_at FROM refresh_tokens WHERE token IN (?, ?)').get(hashToken(refreshToken), refreshToken)
  const user = tokenRow
    ? db.prepare('SELECT id, email, display_name, membership_tier, is_admin, is_suspended FROM users WHERE id = ?').get(tokenRow.user_id)
    : db.prepare('SELECT id, email, display_name, membership_tier, is_admin, is_suspended FROM users WHERE refresh_token IN (?, ?)').get(hashToken(refreshToken), refreshToken)
  if (!user) return c.json({ error: 'refreshToken 无效或已被替换' }, 401)

  // refresh token 过期：清理槽位并返回 401（存量 NULL 视为永不过期，兼容旧客户端）
  if (tokenRow?.expires_at && tokenRow.expires_at < Date.now()) {
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(tokenRow.id)
    logAudit({ action: 'refresh_token_expired', userId: user.id, userEmail: user.email })
    return c.json({ error: 'refreshToken 已过期，请重新登录', code: 'refresh_token_expired' }, 401)
  }

  if (user.is_suspended) {
    return c.json({ error: '账号已被停用，请重新登录或联系管理员' }, 403)
  }

  // 检查账户锁定（refresh 期间也能感知）
  const locked = db.prepare('SELECT locked_until FROM users WHERE id = ?').get(user.id)
  if (locked?.locked_until && locked.locked_until > Date.now()) {
    return c.json({ error: '账户已锁定' }, 423)
  }

  ensureCreditRow(user.id)

  // 老账号补建邀请码（注册时可能还没有邀请码系统）
  try { createInviteCode(user.id) } catch (e) { console.warn('[refresh] 补建邀请码失败:', e.message) }

  const membershipTier = user.membership_tier || 'free'
  const accessToken = jwt.sign({ sub: user.id, email: user.email, is_admin: !!user.is_admin, commercial_mode: COMMERCIAL_MODE, membership_tier: membershipTier }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES })

  // 轮换 refreshToken：原子更新（带过期校验 + 滑动续期），并发刷新时后到者覆盖先到者
  const newRefreshToken = generateRefreshToken()
  const refreshedAt = Date.now()
  const newExpiresAt = refreshedAt + REFRESH_TOKEN_TTL_MS
  if (tokenRow) {
    // 存量迁移 + 元数据回填：老行 device_id 为空则补上（同账号无冲突时），同时轮换 token
    const canBackfill = deviceId && !tokenRow.device_id &&
      !db.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ? AND device_id = ? AND id != ?').get(user.id, deviceId, tokenRow.id)
    const updated = db.prepare(
      `UPDATE refresh_tokens
       SET token = ?, last_used_at = ?, expires_at = ?,
           device_id = COALESCE(device_id, ?),
           device_name = COALESCE(?, device_name),
           platform = COALESCE(?, platform),
           app_version = COALESCE(?, app_version)
       WHERE id = ?`
    ).run(hashToken(newRefreshToken), refreshedAt, newExpiresAt, canBackfill ? deviceId : null, deviceName || null, platform || null, appVersion || null, tokenRow.id)
    if (updated.changes === 0) return c.json({ error: 'refreshToken 无效或已被替换' }, 401)
  } else {
    // 从旧 users.refresh_token 迁移到新表（带上设备信息；device_id 冲突时置空避免撞唯一索引）
    const deviceIdSafe = deviceId && !db.prepare('SELECT 1 FROM refresh_tokens WHERE user_id = ? AND device_id = ?').get(user.id, deviceId) ? deviceId : null
    db.prepare('INSERT INTO refresh_tokens (id, user_id, token, device_id, device_name, platform, app_version, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), user.id, hashToken(newRefreshToken), deviceIdSafe, deviceName || null, platform || null, appVersion || null, refreshedAt, refreshedAt, newExpiresAt)
    db.prepare('UPDATE users SET refresh_token = NULL WHERE id = ?').run(user.id)
  }

  // 代管模式下回带 relay 令牌，确保客户端始终持有（幂等，不存在则生成）
  const relayToken = COMMERCIAL_MODE ? ensureRelayToken(user.id) : undefined

  // refresh 时重新读取 DB 里的 membership_tier，
  // 确保管理员改等级后下次 refresh 即生效（不超 1h）
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
    membershipTier,
    canSelfConfigApi: getSubscriptionCap(membershipTier).canSelfConfig || false,
    // 会员 & 积分
    isVip: !!user.is_vip,
    multiplier: user.multiplier || 1.0,
    inviteCode: db.prepare('SELECT code FROM invite_codes WHERE user_id = ?').get(user.id)?.code || '',
    balancePackage: user.balance_package || 0,
    balanceReferral: user.balance_referral || 0,
    balancePurchased: user.balance_purchased || 0,
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
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND token IN (?, ?)').run(payload.sub, hashToken(refreshToken), refreshToken)
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
// 撤销设备即视为安全事件：同步轮换 relay 令牌（per-user 单值，踢掉所有旧代理凭证）。
authRoutes.delete('/devices/:id', (c) => {
  const mw = authMiddleware(c)
  if (mw) return mw
  const userId = c.get('userId')
  const rowId = c.req.param('id')
  const row = db.prepare('SELECT id FROM refresh_tokens WHERE id = ? AND user_id = ?').get(rowId, userId)
  if (!row) return c.json({ error: '设备不存在或无权操作' }, 404)
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(rowId)
  if (COMMERCIAL_MODE) {
    try { rotateRelayToken(userId) } catch (e) { console.warn('[devices revoke] 吊销 relay 令牌失败:', e.message) }
  }
  logAudit({ action: 'device_revoke', userId, userEmail: c.get('userEmail'), detail: `revoked device slot ${rowId}` })
  return c.json({ ok: true })
})
