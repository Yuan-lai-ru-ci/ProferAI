/**
 * 认证服务
 *
 * 管理团队账户的登录、注销和 JWT 令牌。
 * 令牌使用 Electron safeStorage 加密存储。
 *
 * 路由结构（nginx 反代 /proma/ → :3456/）：
 *   baseUrl = http://47.109.108.57/proma
 *   login → POST {baseUrl}/v1/auth/login
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fetch as undiciFetch } from 'undici'
import { getTeamServersConfigPath } from './config-paths'
import { isCommercialBuild } from './build-target'
import { getDeviceAuthInfo } from './identity-service'
import type { TeamServerConfig } from '@proma/shared'

/** 默认 API 路径（服务器端已去除 /api 前缀，通过 /proma → :3456 反代） */
const API_PREFIX = '/v1'

// ===== 团队服务器配置管理 =====

let _servers: TeamServerConfig[] | null = null

function readTeamServers(): TeamServerConfig[] {
  if (_servers) return _servers

  const path = getTeamServersConfigPath()
  if (existsSync(path)) {
    try {
      _servers = JSON.parse(readFileSync(path, 'utf-8'))
      return _servers!
    } catch {
      // 损坏，返回空
    }
  }

  _servers = []
  return _servers
}

function writeTeamServers(servers: TeamServerConfig[]): void {
  const path = getTeamServersConfigPath()
  writeFileSync(path, JSON.stringify(servers, null, 2), 'utf-8')
  _servers = servers
}

/** 获取已配置的团队服务器列表 */
export function listTeamServers(): TeamServerConfig[] {
  return readTeamServers()
}

/** 添加团队服务器配置 */
export function addTeamServer(config: Omit<TeamServerConfig, 'id'>): TeamServerConfig {
  const { randomUUID } = require('node:crypto')
  const servers = readTeamServers()
  const server: TeamServerConfig = { ...config, id: randomUUID() }
  servers.push(server)
  writeTeamServers(servers)
  return server
}

/** 移除团队服务器配置 */
export function removeTeamServer(id: string): void {
  const servers = readTeamServers().filter((s) => s.id !== id)
  writeTeamServers(servers)
}

// ===== JWT 令牌管理 =====

interface AuthTokenStore {
  [serverId: string]: {
    accessToken: string
    refreshToken: string
    /** 长效 relay 令牌 — 代管模式下替代 accessToken 作为 proxy 凭证，不随 1h 过期 */
    relayToken?: string
    /** 账号类型（restricted/standard/advanced），决定工作区配额 */
    accountType?: string
    /** 是否允许自配 API — 独立于账号类型的开关 */
    canSelfConfigApi?: boolean
    tokenExpiresAt: number
    teamAccountId: string
    teamEmail: string
    commercialMode: boolean
    isAdmin: boolean
  }
}

function getTokenStorePath(): string {
  const { join } = require('node:path')
  const { getConfigDir } = require('./config-paths')
  return join(getConfigDir(), 'auth-tokens.enc')
}

function readTokens(): AuthTokenStore {
  const path = getTokenStorePath()
  if (!existsSync(path)) return {}

  try {
    const encrypted = readFileSync(path)
    const { safeStorage } = require('electron')

    // 尝试安全解密
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(encrypted)
        return JSON.parse(decrypted) as AuthTokenStore
      } catch (decryptErr) {
        // 解密失败：可能是 DPAPI 密钥变化（Windows 密码重置、用户切换等）
        console.warn('[认证] safeStorage 解密失败，token 文件可能已损坏:', (decryptErr as Error).message)
        console.warn('[认证] 将删除损坏的 token 文件，下次登录后将使用明文存储作为兜底')
        // 删除损坏的加密文件，避免反复解密失败
        try { require('node:fs').unlinkSync(path) } catch { /* 忽略 */ }
        return {}
      }
    }

    // 回退：明文 JSON（safeStorage 不可用或解密失败后重新登录）
    try {
      return JSON.parse(encrypted.toString('utf-8')) as AuthTokenStore
    } catch {
      console.warn('[认证] token 文件格式无效（非加密非 JSON），已忽略')
      return {}
    }
  } catch (err) {
    console.warn('[认证] 读取令牌失败:', err)
    return {}
  }
}

function writeTokens(tokens: AuthTokenStore): void {
  try {
    const path = getTokenStorePath()
    const { safeStorage } = require('electron')

    if (safeStorage.isEncryptionAvailable()) {
      try {
        // 先做一次加密-解密往返测试，确保 DPAPI 状态正常
        const testData = 'proma-token-test'
        const testEncrypted = safeStorage.encryptString(testData)
        const testDecrypted = safeStorage.decryptString(testEncrypted)
        if (testDecrypted !== testData) {
          throw new Error('safeStorage 往返测试失败：解密结果不匹配')
        }

        const decrypted = JSON.stringify(tokens)
        const encrypted = safeStorage.encryptString(decrypted)
        writeFileSync(path, encrypted)
        console.log('[认证] 令牌已加密存储')
        return
      } catch (encryptErr) {
        console.warn('[认证] safeStorage 加密不可靠，降级为明文存储:', (encryptErr as Error).message)
      }
    }

    // 回退：明文 JSON 存储
    writeFileSync(path, JSON.stringify(tokens, null, 2), 'utf-8')
    console.log('[认证] 令牌已明文存储（safeStorage 不可用或不可靠）')
  } catch (err) {
    console.warn('[认证] 写入令牌失败:', err)
  }
}

// ===== 认证操作 =====

interface LoginResult {
  success: boolean
  teamAccountId?: string
  teamEmail?: string
  displayName?: string
  accountType?: string
  commercialMode?: boolean
  isAdmin?: boolean
  joinedWorkspace?: string
  error?: string
  /** 达到设备上限时返回：需用户撤销一台设备后重试（携带 revokeSlotId） */
  deviceLimit?: {
    maxDevices: number
    devices: Array<{ id: string; deviceName: string; platform?: string | null; lastUsedAt: number }>
  }
}

function resolveCommercialMode(serverCommercialMode?: boolean): boolean {
  return serverCommercialMode === true
}

/**
 * 登录团队服务器（自动注册服务器配置）
 *
 * @param serverUrl 团队服务器地址，如 http://47.109.108.57/proma
 * @param email 邮箱
 * @param password 密码
 */
export async function login(
  serverUrl: string,
  email: string,
  password: string,
  revokeSlotId?: string,
): Promise<LoginResult> {
  // 自动注册服务器配置
  const servers = readTeamServers()
  let server = servers.find((s) => s.baseUrl === serverUrl)
  if (!server) {
    server = {
      id: require('node:crypto').randomUUID(),
      name: new URL(serverUrl).hostname,
      baseUrl: serverUrl,
      authEndpoint: `${API_PREFIX}/auth/login`,
      syncEndpoint: `${API_PREFIX}/sync`,
      provider: 'self-hosted',
      enabled: true,
    }
    servers.push(server)
    writeTeamServers(servers)
  }

  const url = `${server.baseUrl}${API_PREFIX}/auth/login`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await (undiciFetch as unknown as typeof fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, revokeSlotId, ...getDeviceAuthInfo() }),
      signal: controller.signal,
    } as RequestInit)
    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text()
      if (response.status === 409) {
        try {
          const j = JSON.parse(body) as {
            code?: string; error?: string; maxDevices?: number
            devices?: Array<{ id: string; deviceName: string; platform?: string | null; lastUsedAt: number }>
          }
          if (j.code === 'device_limit') {
            return {
              success: false,
              error: j.error || '已达设备上限',
              deviceLimit: { maxDevices: j.maxDevices || 0, devices: j.devices || [] },
            }
          }
        } catch { /* 非结构化 409 → 走通用错误 */ }
      }
      return {
        success: false,
        error: response.status === 401 ? '邮箱或密码错误' : `服务器错误 (${response.status})`,
      }
    }

    const data = (await response.json()) as {
      accessToken: string
      refreshToken: string
      relayToken?: string
      expiresAt: number
      userId: string
      email: string
      displayName?: string
      accountType?: string
      canSelfConfigApi?: boolean
      isAdmin?: boolean
      commercialMode?: boolean
      joinedWorkspace?: string
    }

    const commercialMode = resolveCommercialMode(data.commercialMode)

    // 加密存储令牌
    const tokens = readTokens()
    tokens[server.id] = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      relayToken: data.relayToken || undefined,
      accountType: data.accountType || 'standard',
      canSelfConfigApi: data.canSelfConfigApi || false,
      tokenExpiresAt: data.expiresAt,
      teamAccountId: data.userId,
      teamEmail: data.email,
      commercialMode,
      isAdmin: !!data.isAdmin,
    }
    writeTokens(tokens)

    console.log(
      `[认证] 登录成功: ${data.email} (${data.userId}), serverCommercialMode=${!!data.commercialMode}, effectiveCommercialMode=${commercialMode}`,
    )

    // 启动主动 token 续期：过期前自动刷新，用户无感
    scheduleAutoRefresh()

    // 商业模式下自动同步渠道
    if (commercialMode) {
      try {
        const { syncChannelsFromServer } = require('./channel-manager')
        await syncChannelsFromServer(server.baseUrl, data.accessToken)
      } catch (err) {
        console.warn('[认证] 渠道同步失败（非致命）:', err)
      }
    }

    return {
      success: true,
      teamAccountId: data.userId,
      teamEmail: data.email,
      displayName: data.displayName,
      accountType: data.accountType,
      commercialMode,
      isAdmin: !!data.isAdmin,
    }
  } catch (err) {
    console.error('[认证] 登录请求失败:', err)
    return { success: false, error: '无法连接到团队服务器' }
  }
}

/**
 * 注册账户（个人/团队）
 */
export async function register(
  serverUrl: string,
  email: string,
  password: string,
  displayName: string,
  invitationToken?: string,
  activationCode?: string,
): Promise<LoginResult> {
  const url = `${serverUrl}${API_PREFIX}/auth/register`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await (undiciFetch as unknown as typeof fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName, invitationToken, activationCode, ...getDeviceAuthInfo() }),
      signal: controller.signal,
    } as RequestInit)
    clearTimeout(timeout)

    if (!response.ok) {
      let errorMsg = `服务器错误 (${response.status})`
      try {
        const body = (await response.json()) as { error?: string; message?: string }
        if (body.error) errorMsg = body.error
        else if (body.message) errorMsg = body.message
      } catch {
        // 响应体不是 JSON，使用默认错误消息
      }
      if (response.status === 409) errorMsg = errorMsg || '该邮箱已注册'
      else if (response.status === 410) errorMsg = errorMsg || '邀请码无效或已过期'
      else if (response.status === 400) errorMsg = errorMsg || '请求参数无效'
      else if (response.status === 403) errorMsg = errorMsg || '邀请码无效或已过期'
      else if (response.status === 429) errorMsg = errorMsg || '请求过于频繁，请稍后再试'
      return { success: false, error: errorMsg }
    }

    const data = (await response.json()) as {
      accessToken: string
      refreshToken: string
      relayToken?: string
      expiresAt: number
      userId: string
      email: string
      displayName?: string
      accountType?: string
      canSelfConfigApi?: boolean
      isAdmin?: boolean
      commercialMode?: boolean
      joinedWorkspace?: string
    }

    // 自动注册服务器配置（复用 login 的模式）
    const servers = readTeamServers()
    let server = servers.find((s) => s.baseUrl === serverUrl)
    if (!server) {
      server = {
        id: require('node:crypto').randomUUID(),
        name: new URL(serverUrl).hostname,
        baseUrl: serverUrl,
        authEndpoint: `${API_PREFIX}/auth/login`,
        syncEndpoint: `${API_PREFIX}/sync`,
        provider: 'self-hosted',
        enabled: true,
      }
      servers.push(server)
      writeTeamServers(servers)
    }

    const commercialMode = resolveCommercialMode(data.commercialMode)
    const tokens = readTokens()
    tokens[server.id] = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      relayToken: data.relayToken || undefined,
      accountType: data.accountType || 'standard',
      canSelfConfigApi: data.canSelfConfigApi || false,
      tokenExpiresAt: data.expiresAt,
      teamAccountId: data.userId,
      teamEmail: data.email,
      commercialMode,
      isAdmin: !!data.isAdmin,
    }
    writeTokens(tokens)

    console.log(
      `[认证] 注册成功: ${data.email} (${data.userId}), serverCommercialMode=${!!data.commercialMode}, effectiveCommercialMode=${commercialMode}`,
    )

    // 启动主动 token 续期
    scheduleAutoRefresh()

    // 商业模式下自动同步渠道
    if (commercialMode) {
      try {
        const { syncChannelsFromServer } = require('./channel-manager')
        await syncChannelsFromServer(server.baseUrl, data.accessToken)
      } catch (err) {
        console.warn('[认证] 渠道同步失败（非致命）:', err)
      }
    }
    return {
      success: true,
      teamAccountId: data.userId,
      teamEmail: data.email,
      displayName: data.displayName,
      accountType: data.accountType,
      commercialMode,
      isAdmin: !!data.isAdmin,
      joinedWorkspace: data.joinedWorkspace,
    }
  } catch (err) {
    console.error('[认证] 注册请求失败:', err)
    return { success: false, error: '无法连接到团队服务器' }
  }
}

/** 检查是否存储了有效的 refreshToken（用于启动/休眠恢复时尝试恢复会话） */
export function hasStoredRefreshToken(): boolean {
  const tokens = readTokens()
  for (const id of Object.keys(tokens)) {
    if (tokens[id]?.refreshToken) return true
  }
  return false
}

/** 尝试用 refreshToken 恢复过期会话。返回 true 表示恢复成功 */
export async function tryRestoreSession(): Promise<boolean> {
  if (getAuthStatus().isLoggedIn) return true
  if (!hasStoredRefreshToken()) return false
  console.log('[认证] accessToken 已过期，尝试用 refreshToken 恢复会话...')
  const ok = await refreshAuthToken()
  if (ok) {
    console.log('[认证] 会话恢复成功 ✅')
    // 刷新成功后同步通知所有渲染进程
    const { BrowserWindow } = require('electron')
    const auth = getTeamAuth()
    const tokens = readTokens()
    const firstKey = Object.keys(tokens)[0]
    const restoredEmail = auth && firstKey ? (tokens[firstKey]?.teamEmail || '') : ''
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('team:auth-restored', {
        isLoggedIn: true,
        teamEmail: restoredEmail,
      })
    }
  } else {
    console.warn('[认证] 会话恢复失败 ❌ —— refreshToken 可能已过期或网络不通')
  }
  return ok
}

/** 获取当前登录状态 */
export function getAuthStatus(): {
  isLoggedIn: boolean
  teamAccountId?: string
  teamEmail?: string
} {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)

  if (serverIds.length === 0) return { isLoggedIn: false }

  // 返回第一个未过期的令牌
  const now = Date.now()
  for (const id of serverIds) {
    const token = tokens[id]!
    if (token.tokenExpiresAt > now) {
      return {
        isLoggedIn: true,
        teamAccountId: token.teamAccountId,
        teamEmail: token.teamEmail,
      }
    }
  }

  return { isLoggedIn: false }
}

/** 注销（清除本地令牌和渠道，并通知服务端吊销） */
export async function logout(): Promise<void> {
  // 通知服务端吊销 accessToken
  const tokens = readTokens()
  const servers = listTeamServers()
  for (const server of servers) {
    const token = tokens[server.id]
    if (token) {
      try {
        await (undiciFetch as unknown as typeof fetch)(`${server.baseUrl}${API_PREFIX}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.accessToken}` },
          body: JSON.stringify({ deviceId: getDeviceAuthInfo().deviceId }),
        })
      } catch { /* 网络错误忽略 */ }
    }
  }

  writeTokens({})

  // 清除渠道配置：防止登出后旧渠道残留磁盘，下个用户可见
  try {
    const { writeFileSync } = require('node:fs')
    const { getChannelsPath } = require('./config-paths')
    writeFileSync(getChannelsPath(), JSON.stringify({ version: 1, channels: [] }), 'utf-8')
  } catch { /* 非致命 */ }

  // 清除服务端内存缓存：防止登出后 _servers 残留
  _servers = null

  console.log('[认证] 已注销')
}

// 自动续期定时器引用
let _autoRefreshTimer: ReturnType<typeof setTimeout> | null = null

/** 启动主动 token 续期：accessToken 过期前 5 分钟自动刷新 */
export function scheduleAutoRefresh(): void {
  if (_autoRefreshTimer) clearTimeout(_autoRefreshTimer)
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  if (serverIds.length === 0) return

  // 找最近过期的 token
  let earliest = Infinity
  for (const id of serverIds) {
    const t = tokens[id]
    if (t && t.refreshToken && t.tokenExpiresAt > Date.now()) {
      earliest = Math.min(earliest, t.tokenExpiresAt)
    }
  }
  if (earliest === Infinity) return

  // 过期前 5 分钟刷新（最小 30 秒）
  const delay = Math.max(30000, earliest - Date.now() - 5 * 60 * 1000)
  _autoRefreshTimer = setTimeout(async () => {
    const ok = await refreshAuthToken().catch(() => false)
    if (ok) console.log('[认证] Token 自动续期成功')
    else console.warn('[认证] Token 自动续期失败，将在 60s 后重试')
    // 无论成功失败，60 秒后再试（成功时 scheduleAutoRefresh 会被重新调用）
    if (!ok) _autoRefreshTimer = setTimeout(() => scheduleAutoRefresh(), 60000)
    else scheduleAutoRefresh()
  }, delay)
  console.log(`[认证] 将在 ${Math.round(delay / 60000)} 分钟后自动续期 token`)
}

/** 刷新 accessToken（用 refreshToken 换新的） */
export async function refreshAuthToken(): Promise<boolean> {
  const tokens = readTokens()
  const servers = listTeamServers()

  console.log(`[认证] 开始刷新 token，共 ${servers.length} 个服务器配置`)

  for (const server of servers) {
    const token = tokens[server.id]
    if (!token || !token.refreshToken) {
      console.log(`[认证] 跳过服务器 ${server.baseUrl}: 无 token 或无 refreshToken`)
      continue
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      console.log(`[认证] 向 ${server.baseUrl}/v1/auth/refresh 发送刷新请求...`)
      const response = await (undiciFetch as unknown as typeof fetch)(
        `${server.baseUrl}${API_PREFIX}/auth/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: token.refreshToken, ...getDeviceAuthInfo() }),
          signal: controller.signal,
        } as RequestInit,
      )
      clearTimeout(timeout)

      if (response.ok) {
        const data = await response.json() as { accessToken: string; relayToken?: string; refreshToken?: string; expiresAt: number; commercialMode?: boolean; isAdmin?: boolean; accountType?: string; canSelfConfigApi?: boolean }
        console.log(`[认证] 刷新成功，新 token 过期时间: ${new Date(data.expiresAt).toISOString()}`)
        const commercialMode = data.commercialMode === undefined
          ? resolveCommercialMode(token.commercialMode)
          : resolveCommercialMode(data.commercialMode)
        tokens[server.id] = {
          ...token,
          accessToken: data.accessToken,
          relayToken: data.relayToken ?? token.relayToken,
          refreshToken: data.refreshToken ?? token.refreshToken,
          accountType: data.accountType ?? token.accountType,
          canSelfConfigApi: data.canSelfConfigApi ?? token.canSelfConfigApi,
          tokenExpiresAt: data.expiresAt,
          commercialMode,
          isAdmin: data.isAdmin ?? token.isAdmin,
        }
        writeTokens(tokens)
        // 刷新成功后重新排下一次续期
        scheduleAutoRefresh()
        return true
      } else {
        const body = await response.text().catch(() => '(无法读取响应体)')
        console.warn(`[认证] 刷新失败: HTTP ${response.status} — ${body.slice(0, 200)}`)
      }
    } catch (err) {
      console.warn(`[认证] 刷新请求异常:`, (err as Error).message || err)
    }
  }

  console.warn('[认证] 所有服务器 token 刷新均失败')
  return false
}

/** 当前会话是否处于商业模式（登录时存储的标记，不依赖 token 是否过期） */
export function getCommercialMode(): boolean {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  for (const id of serverIds) {
    // commercialMode 是登录时写死的标记，不应因 token 过期而翻转。
    // token 过期时 refresh 流程会重新获取，商业模式判断不应阻断 refresh。
    if (tokens[id]!.commercialMode === true) return true
  }
  return false
}

/** 当前用户是否为管理员 */
export function getIsAdmin(): boolean {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  for (const id of serverIds) {
    if (tokens[id]!.tokenExpiresAt > Date.now()) {
      return tokens[id]!.isAdmin === true
    }
  }
  return false
}

/**
 * 获取有效的访问令牌（自动刷新过期令牌）
 */
export function getAccessToken(): string | null {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  if (serverIds.length === 0) return null

  const now = Date.now()
  for (const id of serverIds) {
    const token = tokens[id]!
    if (token.tokenExpiresAt > now) {
      return token.accessToken
    }
  }

  return null
}

/**
 * 获取第一个已认证的服务器 baseUrl + token 配对
 * 确保 baseUrl 和 token 属于同一个服务器，避免多服务器场景下令牌错配
 */
/** 获取已连接服务器信息列表 */
export function getServerInfoList(): Array<{ baseUrl: string; email: string; isLoggedIn: boolean }> {
  const tokens = readTokens()
  const servers = listTeamServers()
  const now = Date.now()
  return servers.map((s) => {
    const t = tokens[s.id]
    return {
      baseUrl: s.baseUrl,
      email: t?.teamEmail || '',
      isLoggedIn: !!(t && t.tokenExpiresAt > now),
    }
  })
}

export function getTeamAuth(): { baseUrl: string; token: string; proxyToken?: string; accountType?: string; canSelfConfigApi?: boolean } | null {
  const tokens = readTokens()
  const servers = listTeamServers()
  const now = Date.now()

  for (const server of servers) {
    const token = tokens[server.id]
    if (token && token.tokenExpiresAt > now) {
      // token = JWT accessToken（向后兼容，所有非 proxy 端点用这个）
      // proxyToken = relay 令牌（打 /v1/proxy 用，长效不过期）
      //
      // 这里的判定口径必须与消费方（chat-service / agent-orchestrator）的
      // shouldUseCommercialProxy = isCommercialBuild() || isCommercialMode() 完全一致。
      // 否则「OSS 构建但服务端标 commercialMode」时消费方会进 proxy 分支，
      // 而 proxyToken 为空回退到 1h 的 accessToken，导致长任务 60 分钟后 401。
      const isCommercial = token.commercialMode || isCommercialBuild()
      return {
        baseUrl: server.baseUrl,
        token: token.accessToken,
        proxyToken: isCommercial ? token.relayToken : undefined,
        accountType: token.accountType,
        canSelfConfigApi: token.canSelfConfigApi,
      }
    }
  }

  return null
}

/** 取当前团队服务器 baseUrl + 有效 accessToken（JWT，过期先刷新）。无登录返回 null。 */
async function getAccessTokenForApi(): Promise<{ baseUrl: string; token: string } | null> {
  const pick = () => {
    const tokens = readTokens()
    for (const server of listTeamServers()) {
      const t = tokens[server.id]
      if (t?.accessToken) {
        return { baseUrl: server.baseUrl, token: t.accessToken, expired: !(t.tokenExpiresAt > Date.now()) }
      }
    }
    return null
  }
  let cur = pick()
  if (!cur) return null
  if (cur.expired) {
    await refreshAuthToken().catch(() => false)
    cur = pick()
    if (!cur) return null
  }
  return { baseUrl: cur.baseUrl, token: cur.token }
}

/** 拉取当前账号的登录设备列表（含本机 deviceId 用于标注）。走 accessToken(JWT)。 */
export async function listRemoteDevices(): Promise<{
  ok: boolean
  devices?: Array<{ id: string; deviceId: string | null; deviceName: string; platform: string | null; appVersion?: string | null; createdAt: number; lastUsedAt: number }>
  currentDeviceId?: string
  error?: string
}> {
  const currentDeviceId = getDeviceAuthInfo().deviceId
  const auth = await getAccessTokenForApi()
  if (!auth) return { ok: false, error: '未登录团队账号', currentDeviceId }
  try {
    let resp = await (undiciFetch as unknown as typeof fetch)(`${auth.baseUrl}${API_PREFIX}/auth/devices`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (resp.status === 401) {
      await refreshAuthToken().catch(() => false)
      const fresh = await getAccessTokenForApi()
      if (fresh) {
        resp = await (undiciFetch as unknown as typeof fetch)(`${fresh.baseUrl}${API_PREFIX}/auth/devices`, {
          headers: { Authorization: `Bearer ${fresh.token}` },
        })
      }
    }
    if (!resp.ok) return { ok: false, error: `服务器错误 (${resp.status})`, currentDeviceId }
    const data = (await resp.json()) as { devices: NonNullable<Awaited<ReturnType<typeof listRemoteDevices>>['devices']> }
    return { ok: true, devices: data.devices || [], currentDeviceId }
  } catch {
    return { ok: false, error: '无法连接团队服务器', currentDeviceId }
  }
}

/** 撤销（远程登出）指定设备槽位。走 accessToken(JWT)。 */
export async function revokeRemoteDevice(slotId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAccessTokenForApi()
  if (!auth) return { ok: false, error: '未登录团队账号' }
  try {
    const resp = await (undiciFetch as unknown as typeof fetch)(
      `${auth.baseUrl}${API_PREFIX}/auth/devices/${encodeURIComponent(slotId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } },
    )
    if (!resp.ok) return { ok: false, error: `服务器错误 (${resp.status})` }
    return { ok: true }
  } catch {
    return { ok: false, error: '无法连接团队服务器' }
  }
}

/** 代管模式下当前用户是否允许自配 API（独立于账号类型的开关，不依赖 token 过期） */
export function isSelfConfigAllowed(): boolean {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  for (const id of serverIds) {
    if (tokens[id]!.canSelfConfigApi === true) return true
  }
  return false
}

/** 获取当前用户的 accountType（不存在则返回 'standard'，不依赖 token 过期） */
export function getAccountType(): string {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  for (const id of serverIds) {
    if (tokens[id]!.accountType) return tokens[id]!.accountType!
  }
  return 'standard'
}

export async function getTeamAuthWithRefresh(): Promise<{ baseUrl: string; token: string; proxyToken?: string; accountType?: string; canSelfConfigApi?: boolean } | null> {
  const current = getTeamAuth()
  if (current) return current

  const refreshed = await refreshAuthToken().catch(() => false)
  if (!refreshed) return null
  return getTeamAuth()
}
