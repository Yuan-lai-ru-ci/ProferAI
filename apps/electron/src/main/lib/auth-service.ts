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
      } catch {
        // 解密失败，尝试明文读取
      }
    }

    // 回退：明文 JSON
    try {
      return JSON.parse(encrypted.toString('utf-8')) as AuthTokenStore
    } catch {
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
      const decrypted = JSON.stringify(tokens)
      const encrypted = safeStorage.encryptString(decrypted)
      writeFileSync(path, encrypted)
    } else {
      // 回退：明文 JSON（开发环境 / 未签名应用）
      console.warn('[认证] safeStorage 不可用，令牌将明文存储')
      writeFileSync(path, JSON.stringify(tokens, null, 2), 'utf-8')
    }
  } catch (err) {
    console.warn('[认证] 写入令牌失败:', err)
  }
}

// ===== 认证操作 =====

interface LoginResult {
  success: boolean
  teamAccountId?: string
  teamEmail?: string
  error?: string
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
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    } as RequestInit)
    clearTimeout(timeout)

    if (!response.ok) {
      const body = await response.text()
      return {
        success: false,
        error: response.status === 401 ? '邮箱或密码错误' : `服务器错误 (${response.status})`,
      }
    }

    const data = (await response.json()) as {
      accessToken: string
      refreshToken: string
      expiresAt: number
      userId: string
      email: string
      isAdmin?: boolean
      commercialMode?: boolean
    }

    // 加密存储令牌
    const tokens = readTokens()
    tokens[server.id] = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      tokenExpiresAt: data.expiresAt,
      teamAccountId: data.userId,
      teamEmail: data.email,
      commercialMode: !!data.commercialMode,
      isAdmin: !!data.isAdmin,
    }
    writeTokens(tokens)

    console.log(`[认证] 登录成功: ${data.email} (${data.userId}), commercialMode=${!!data.commercialMode}`)

    // 商业模式下自动同步渠道
    if (data.commercialMode) {
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
    }
  } catch (err) {
    console.error('[认证] 登录请求失败:', err)
    return { success: false, error: '无法连接到团队服务器' }
  }
}

/**
 * 注册团队账户
 */
export async function register(
  serverUrl: string,
  email: string,
  password: string,
  displayName: string,
  invitationToken?: string,
): Promise<LoginResult> {
  const url = `${serverUrl}${API_PREFIX}/auth/register`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const response = await (undiciFetch as unknown as typeof fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName, invitationToken }),
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
      if (response.status === 409) errorMsg = '该邮箱已注册'
      else if (response.status === 400) errorMsg = errorMsg || '请求参数无效'
      else if (response.status === 403) errorMsg = errorMsg || '邀请码无效或已过期'
      else if (response.status === 429) errorMsg = '请求过于频繁，请稍后再试'
      return { success: false, error: errorMsg }
    }

    const data = (await response.json()) as {
      accessToken: string
      refreshToken: string
      expiresAt: number
      userId: string
      email: string
      isAdmin?: boolean
      commercialMode?: boolean
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

    const tokens = readTokens()
    tokens[server.id] = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      tokenExpiresAt: data.expiresAt,
      teamAccountId: data.userId,
      teamEmail: data.email,
      commercialMode: !!data.commercialMode,
      isAdmin: !!data.isAdmin,
    }
    writeTokens(tokens)

    console.log(`[认证] 注册成功: ${data.email} (${data.userId}), commercialMode=${!!data.commercialMode}`)

    // 商业模式下自动同步渠道
    if (data.commercialMode) {
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
    }
  } catch (err) {
    console.error('[认证] 注册请求失败:', err)
    return { success: false, error: '无法连接到团队服务器' }
  }
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

/** 注销（清除本地令牌，并通知服务端吊销） */
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
          headers: { Authorization: `Bearer ${token.accessToken}` },
        })
      } catch { /* 网络错误忽略 */ }
    }
  }

  writeTokens({})
  console.log('[认证] 已注销')
}

/** 刷新 accessToken（用 refreshToken 换新的） */
export async function refreshAuthToken(): Promise<boolean> {
  const tokens = readTokens()
  const servers = listTeamServers()

  for (const server of servers) {
    const token = tokens[server.id]
    if (!token || !token.refreshToken) continue

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const response = await (undiciFetch as unknown as typeof fetch)(
        `${server.baseUrl}${API_PREFIX}/auth/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: token.refreshToken }),
          signal: controller.signal,
        } as RequestInit,
      )
      clearTimeout(timeout)

      if (response.ok) {
        const data = await response.json() as { accessToken: string; expiresAt: number }
        tokens[server.id] = {
          ...token,
          accessToken: data.accessToken,
          tokenExpiresAt: data.expiresAt,
        }
        writeTokens(tokens)
        return true
      }
    } catch { /* 网络错误，继续尝试下一个 */ }
  }

  return false
}

/** 当前会话是否处于商业模式 */
export function getCommercialMode(): boolean {
  const tokens = readTokens()
  const serverIds = Object.keys(tokens)
  for (const id of serverIds) {
    if (tokens[id]!.tokenExpiresAt > Date.now()) {
      return tokens[id]!.commercialMode === true
    }
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

export function getTeamAuth(): { baseUrl: string; token: string } | null {
  const tokens = readTokens()
  const servers = listTeamServers()
  const now = Date.now()

  for (const server of servers) {
    const token = tokens[server.id]
    if (token && token.tokenExpiresAt > now) {
      return { baseUrl: server.baseUrl, token: token.accessToken }
    }
  }

  return null
}
