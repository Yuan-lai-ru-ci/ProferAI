/**
 * 渠道管理器
 *
 * 负责渠道的 CRUD 操作、API Key 加密/解密、连接测试。
 * 使用 Electron safeStorage 进行 API Key 加密（底层使用 OS 级加密）。
 * 数据持久化到 ~/.proma/channels.json。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { getChannelsPath } from './config-paths'
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelsConfig,
  ChannelTestResult,
  ChannelModel,
  FetchModelsInput,
  FetchModelsResult,
  ProviderType,
} from '@proma/shared'
import { PROVIDER_DEFAULT_AGENT_URLS, PROVIDER_DEFAULT_URLS } from '@proma/shared'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { normalizeBaseUrl, normalizeAnthropicProviderUrl, getPromaUserAgent } from '@proma/core'
import { isCommercialBuild } from './build-target'
import {
  inferAgentBaseUrl,
  normalizeChannelForCurrentSchema,
  normalizeConfigForCurrentSchema,
} from './channel-url-routing'
import pkg from '../../../package.json' with { type: 'json' }

/** 当前配置版本 */
const CONFIG_VERSION = 1

export function resolveChannelAgentBaseUrl(channel: Pick<Channel, 'provider' | 'baseUrl' | 'agentBaseUrl'>): string | undefined {
  return inferAgentBaseUrl(channel.provider, channel.baseUrl, channel.agentBaseUrl)
}

/**
 * 读取渠道配置文件
 */
function readConfig(): ChannelsConfig {
  const configPath = getChannelsPath()

  if (!existsSync(configPath)) {
    return { version: CONFIG_VERSION, channels: [] }
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as ChannelsConfig
    const normalized = normalizeConfigForCurrentSchema(parsed)
    if (normalized.changed) {
      try {
        writeFileSync(configPath, JSON.stringify(normalized.config, null, 2), 'utf-8')
        console.log('[渠道管理] 已迁移渠道配置：拆分 Chat Base URL 与 Agent Base URL')
      } catch (error) {
        console.warn('[渠道管理] 写入迁移后的渠道配置失败，将继续使用内存中的迁移结果:', error)
      }
    }
    return normalized.config
  } catch (error) {
    console.error('[渠道管理] 读取配置文件失败:', error)
    return { version: CONFIG_VERSION, channels: [] }
  }
}

/**
 * 写入渠道配置文件
 */
function writeConfig(config: ChannelsConfig): void {
  const configPath = getChannelsPath()

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    console.error('[渠道管理] 写入配置文件失败:', error)
    throw new Error('写入渠道配置失败')
  }
}

/**
 * 加密 API Key
 *
 * 使用 Electron safeStorage 加密，底层使用：
 * - macOS: Keychain
 * - Windows: DPAPI
 * - Linux: Secret Service API
 *
 * @returns base64 编码的加密字符串
 */
function encryptApiKey(plainKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[渠道管理] safeStorage 加密不可用，将以明文存储')
    return plainKey
  }

  const encrypted = safeStorage.encryptString(plainKey)
  return encrypted.toString('base64')
}

/**
 * 解密 API Key
 *
 * @param encryptedKey base64 编码的加密字符串
 * @returns 明文 API Key
 */
function decryptKey(encryptedKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // 如果加密不可用，假设存储的是明文
    return encryptedKey
  }

  try {
    const buffer = Buffer.from(encryptedKey, 'base64')
    return safeStorage.decryptString(buffer)
  } catch (error) {
    console.error('[渠道管理] 解密 API Key 失败:', error)
    throw new Error('解密 API Key 失败')
  }
}

/**
 * 从服务端同步渠道到本地
 *
 * 仅商业模式下调用。拉取服务端渠道 → 加密 API Key → 覆盖本地 channels.json。
 * 同时备份旧配置到 channels.json.server-backup。
 */
export async function syncChannelsFromServer(serverBaseUrl: string, accessToken: string): Promise<void> {
  const fetchFn = await getFetchFn()
  const url = `${serverBaseUrl}/v1/account/channels`

  const resp = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!resp.ok) {
    throw new Error(`渠道同步失败: HTTP ${resp.status}`)
  }

  const data = await resp.json() as { commercialMode: boolean; channels: Array<{ id: string; name: string; provider: string; apiKey: string; baseUrl: string; agentBaseUrl?: string; models: ChannelModel[] }> }

  if (!data.commercialMode || !data.channels) return

  // 防止空列表雪崩：服务端返回 0 条渠道时跳过同步，保留现有本地缓存。
  // 空结果通常是服务端异常导致，不应将客户端全部渠道清空。
  if (data.channels.length === 0) {
    console.warn('[渠道管理] 服务端返回空渠道列表，跳过同步以保留现有渠道')
    return
  }

  // 备份旧配置
  const configPath = getChannelsPath()
  if (existsSync(configPath)) {
    try {
      const backupPath = configPath + '.server-backup'
      writeFileSync(backupPath, readFileSync(configPath))
    } catch { /* 备份失败不致命 */ }
  }

  // 将服务端渠道写入本地，保留用户自建的本地渠道
  const existingConfig = readConfig()
  const serverIds = new Set(data.channels.map((ch) => ch.id))

  // 清理已不在服务端列表中的 serverManaged 渠道（服务端已删除的渠道）
  const preCleanupCount = existingConfig.channels.length
  const localChannels = existingConfig.channels.filter((c) => {
    if (serverIds.has(c.id)) return false // 服务端仍在管理，后面会用最新数据覆盖
    if (c.serverManaged || c.id.startsWith('newapi-')) return false // 之前由服务端管理但现在不在列表中了 → 已删除，清理
    return true // 用户自建本地渠道，保留
  })
  const cleanedCount = preCleanupCount - localChannels.length - serverIds.size
  if (cleanedCount > 0) {
    console.log(`[渠道管理] 清理了 ${cleanedCount} 个服务端已删除的渠道`)
  }

  const now = Date.now()
  const config: ChannelsConfig = { version: 1, channels: [...localChannels] }

  for (const ch of data.channels) {
    // 本地已有同 ID 渠道时：保留用户启停状态（enabled + 模型级 enabled）
    const localExisting = existingConfig.channels.find((c) => c.id === ch.id)
    const mergedModels = ch.models.map((m: any) => {
      const localModel = localExisting?.models?.find((lm: any) => lm.id === (m.id || m.name))
      return { ...m, enabled: localModel ? localModel.enabled : (m.enabled !== false) }
    })
    const result = normalizeChannelForCurrentSchema({
      id: ch.id,
      name: ch.name,
      provider: ch.provider as ProviderType,
      baseUrl: ch.baseUrl,
      agentBaseUrl: ch.agentBaseUrl || '',
      apiKey: encryptApiKey(ch.apiKey),
      models: mergedModels,
      enabled: localExisting?.enabled ?? true,
      serverManaged: true,
      createdAt: localExisting?.createdAt ?? now,
      updatedAt: now,
    })
    config.channels.push(result.channel)
  }

  writeConfig(config)
  console.log(`[渠道管理] 已从服务端同步 ${config.channels.length} 个渠道`)

  // 首次同步时自动配置 Agent 供应商（用户手动配过后不再覆盖）
  if (config.channels.length > 0) {
    try {
      const { updateSettings, getSettings } = require('./settings-service')
      const settings = getSettings()
      // 已配置过 → 不覆盖用户选择
      if (settings.agentChannelIds && settings.agentChannelIds.length > 0) {
        // 静默跳过
      } else {
        const agentCapableChannels = config.channels.filter((c) => {
          const { isAgentCompatibleProvider } = require('@proma/shared')
          return isAgentCompatibleProvider(c.provider)
        })
        const agentIds = agentCapableChannels.map((c) => c.id)
        const firstAgent = agentCapableChannels[0]
        const firstModel = firstAgent?.models?.find((m) => m.enabled)

        updateSettings({
          agentChannelIds: agentIds,
          agentChannelId: settings.agentChannelId || firstAgent?.id,
          agentModelId: settings.agentModelId || firstModel?.id,
        })
        console.log(`[渠道管理] 首次自动配置 ${agentIds.length} 个 Agent 供应商`)
      }
    } catch (err) {
      console.warn('[渠道管理] 自动配置 Agent 供应商失败:', err)
    }
  }
}

/** 当前是否处于商业模式（渠道由服务端统一管理） */
export function isCommercialMode(): boolean {
  try {
    const { getCommercialMode } = require('./auth-service')
    return getCommercialMode()
  } catch {
    return false
  }
}

/** 当前用户是否可以自配渠道（代管模式 + 自配开关 = 可自配） */
export function canSelfConfig(): boolean {
  try {
    const { isSelfConfigAllowed } = require('./auth-service')
    return isSelfConfigAllowed()
  } catch {
    return false
  }
}

/**
 * 获取所有渠道
 *
 * 返回的渠道中 apiKey 保持加密状态。
 * 首次调用时，如果没有任何 DeepSeek 渠道，自动创建预设渠道。
 */
export function listChannels(): Channel[] {
  const config = readConfig()

  // 首次使用：如果没有 DeepSeek 渠道，自动创建预设
  const hasDeepSeek = config.channels.some(
    (c) => c.provider === 'deepseek' || c.baseUrl.includes('api.deepseek.com'),
  )
  if (!hasDeepSeek) {
    const now = Date.now()
    const presetChannel: Channel = {
      id: randomUUID(),
      name: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
      agentBaseUrl: PROVIDER_DEFAULT_AGENT_URLS.deepseek,
      apiKey: encryptApiKey(''),
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
      ],
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }
    config.channels.push(presetChannel)
    writeConfig(config)
    console.log('[渠道管理] 已自动创建 DeepSeek 预设渠道')
    return config.channels
  }

  return config.channels
}

/**
 * 按 ID 获取渠道
 *
 * 返回的渠道中 apiKey 保持加密状态。
 */
export function getChannelById(id: string): Channel | undefined {
  const config = readConfig()
  return config.channels.find((c) => c.id === id)
}

/**
 * 创建新渠道
 *
 * @param input 渠道创建数据（apiKey 为明文，会自动加密）
 * @returns 创建后的渠道（apiKey 为加密态）
 */
export function createChannel(input: ChannelCreateInput): Channel {
  if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下不允许手动创建渠道，渠道由服务端统一管理')
  const config = readConfig()
  const now = Date.now()

  const rawChannel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    agentBaseUrl: input.agentBaseUrl,
    apiKey: encryptApiKey(input.apiKey),
    models: input.models,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  }
  const { channel } = normalizeChannelForCurrentSchema(rawChannel)

  config.channels.push(channel)
  writeConfig(config)

  console.log(`[渠道管理] 已创建渠道: ${channel.name} (${channel.id})`)
  return channel
}

/**
 * 更新渠道
 *
 * @param id 渠道 ID
 * @param input 更新数据（apiKey 为明文，空字符串表示不更新）
 * @returns 更新后的渠道
 */
export function updateChannel(id: string, input: ChannelUpdateInput): Channel {
  // 官方同步渠道（newapi-*）：允许切换 channel enabled + 模型 enabled，不允许改名称/供应商/API Key/增删模型
  if (id.startsWith('newapi-')) {
    if (input.name !== undefined || input.provider !== undefined ||
        input.baseUrl !== undefined || input.agentBaseUrl !== undefined ||
        input.apiKey !== undefined) {
      throw new Error('官方渠道由平台统一管理，不可修改')
    }
    if (input.models !== undefined) {
      const config = readConfig()
      const existing = config.channels.find((c) => c.id === id)
      if (existing) {
        const oldIds = new Set(existing.models.map(m => m.id))
        const newIds = new Set(input.models.map(m => m.id))
        if (oldIds.size !== newIds.size || ![...oldIds].every(oid => newIds.has(oid))) {
          throw new Error('官方渠道不可增删模型，仅可控制启用/停用')
        }
      }
    }
  }
  // 商业模式下无自配权限时只允许切换 enabled，有自配权限则全部放开
  if (isCommercialMode() && !canSelfConfig()) {
    const hasStructuralChange =
      input.name !== undefined ||
      input.provider !== undefined ||
      input.baseUrl !== undefined ||
      input.agentBaseUrl !== undefined ||
      input.apiKey !== undefined ||
      input.models !== undefined
    if (hasStructuralChange) {
      throw new Error('商业模式下不允许修改渠道，渠道由服务端统一管理')
    }
  }
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const existing = config.channels[index]!

  const rawUpdated: Channel = {
    ...existing,
    name: input.name ?? existing.name,
    provider: input.provider ?? existing.provider,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    agentBaseUrl: input.agentBaseUrl !== undefined ? input.agentBaseUrl : existing.agentBaseUrl,
    apiKey: input.apiKey ? encryptApiKey(input.apiKey) : existing.apiKey,
    models: input.models ?? existing.models,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now(),
  }
  const { channel: updated } = normalizeChannelForCurrentSchema(rawUpdated)

  config.channels[index] = updated
  writeConfig(config)

  console.log(`[渠道管理] 已更新渠道: ${updated.name} (${updated.id})`)
  return updated
}

/**
 * 删除渠道
 */
export function deleteChannel(id: string): void {
  if (id.startsWith('newapi-')) throw new Error('官方同步渠道不可删除，请在 New API 后台管理')
  if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下不允许删除渠道，渠道由服务端统一管理')
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const removed = config.channels.splice(index, 1)[0]!
  writeConfig(config)

  console.log(`[渠道管理] 已删除渠道: ${removed.name} (${removed.id})`)
}

/**
 * 解密渠道的 API Key
 *
 * 仅在用户需要查看时调用。
 */
export function decryptApiKey(channelId: string): string {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    throw new Error(`渠道不存在: ${channelId}`)
  }

  return decryptKey(channel.apiKey)
}

/**
 * 测试渠道连接
 *
 * 向供应商的 API 发送简单请求，验证 API Key 和连接是否有效。
 */
export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    return { success: false, message: '渠道不存在' }
  }

  const apiKey = decryptKey(channel.apiKey)
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (channel.provider) {
      case 'anthropic':
      case 'anthropic-compatible':
      case 'kimi-api':
      case 'kimi-coding':
      case 'zhipu-coding':
      case 'minimax':
      case 'xiaomi':
      case 'xiaomi-token-plan':
        return await testAnthropicCompatible(channel.baseUrl, apiKey, proxyUrl, channel.provider)
      case 'openai':
      case 'deepseek':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(channel.baseUrl, apiKey, proxyUrl)
      case 'google':
        return await testGoogle(channel.baseUrl, apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${channel.provider}。你可能过去使用的是 Proma 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

/**
 * 测试 Anthropic 兼容 API 连接（Anthropic / DeepSeek / Kimi API / Kimi Coding Plan / MiniMax）
 *
 * DeepSeek / Kimi 的 Anthropic API 端点无需 /v1 前缀。
 * Kimi Coding Plan 必须发送 Proma User-Agent，否则返回 403。
 */
async function testAnthropicCompatible(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
): Promise<ChannelTestResult> {
  const url = normalizeAnthropicProviderUrl(baseUrl, provider)
  const fetchFn = getFetchFn(proxyUrl)

  let testModel: string
  switch (provider) {
    case 'deepseek':
      testModel = 'deepseek-v4-pro'
      break
    case 'kimi-api':
      testModel = 'kimi-k2.6'
      break
    case 'kimi-coding':
      testModel = 'kimi-for-coding'
      break
    case 'zhipu-coding':
      testModel = 'glm-5.2'
      break
    case 'minimax':
      testModel = 'MiniMax-M3'
      break
    case 'xiaomi':
    case 'xiaomi-token-plan':
      testModel = 'mimo-v2.5-pro'
      break
    default:
      testModel = 'claude-sonnet-4-6'
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (provider === 'kimi-coding' || provider === 'zhipu-coding') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getPromaUserAgent(pkg.version)
  } else if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getPromaUserAgent(pkg.version)
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const endpoint = `${url}/messages`
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: testModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  const text = await response.text().catch(() => '')

  if (response.status === 401) {
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}` }
  }

  const detail = text ? `: ${text.slice(0, 200)}` : ''
  const endpointHint = provider === 'deepseek'
    ? `；当前测试端点为 ${endpoint}。DeepSeek 内置渠道使用 Anthropic 协议，Base URL 应为 https://api.deepseek.com/anthropic，而不是 OpenAI 兼容的 /v1`
    : `；当前测试端点为 ${endpoint}`

  return { success: false, message: `请求失败 (${response.status})${detail}${endpointHint}` }
}

/**
 * 测试 OpenAI 兼容 API 连接（OpenAI / Custom）
 */
async function testOpenAICompatible(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

/**
 * 测试 Google Generative AI API 连接
 */
async function testGoogle(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

// ===== 直接测试连接 =====

/**
 * 直接测试连接（无需已保存渠道）
 *
 * 使用传入的明文凭证直接向提供商发送测试请求。
 * 适用于创建/编辑渠道时用户在保存前先验证连接。
 */
export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
      case 'anthropic-compatible':
      case 'kimi-api':
      case 'kimi-coding':
      case 'zhipu-coding':
      case 'minimax':
      case 'xiaomi':
      case 'xiaomi-token-plan':
        return await testAnthropicCompatible(input.baseUrl, input.apiKey, proxyUrl, input.provider)
      case 'openai':
      case 'deepseek':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await testGoogle(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的提供商: ${input.provider}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

// ===== 模型拉取相关 =====

/**
 * 从供应商 API 拉取可用模型列表
 *
 * 直接使用传入的凭证（无需已保存渠道），支持创建渠道时预先拉取模型。
 * 针对不同供应商使用不同的 API 端点和响应解析。
 */
export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
      case 'anthropic-compatible':
      case 'kimi-api':
      case 'kimi-coding':
      case 'zhipu-coding':
      case 'minimax':
      case 'xiaomi':
      case 'xiaomi-token-plan':
        return await fetchAnthropicCompatibleModels(input.baseUrl, input.apiKey, proxyUrl, input.provider)
      case 'openai':
      case 'deepseek':
      case 'zhipu':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await fetchOpenAICompatibleModels(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await fetchGoogleModels(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${input.provider}`, models: [] }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error('[渠道管理] 拉取模型列表失败:', error)
    return { success: false, message: `拉取模型失败: ${message}`, models: [] }
  }
}

/**
 * Anthropic API 模型响应项
 */
interface AnthropicModelItem {
  id: string
  display_name?: string
  type?: string
}

/**
 * 从 Anthropic 兼容 API 拉取模型列表（Anthropic / DeepSeek / Kimi API / Kimi Coding Plan / MiniMax）
 *
 * DeepSeek / Kimi 的 Anthropic API 端点无需 /v1 前缀。
 * Kimi Coding Plan 必须发送 Proma User-Agent。
 * 文档: https://docs.anthropic.com/en/api/models-list
 */
async function fetchAnthropicCompatibleModels(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
): Promise<FetchModelsResult> {
  const url = normalizeAnthropicProviderUrl(baseUrl, provider)
  const fetchFn = getFetchFn(proxyUrl)

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (provider === 'kimi-coding' || provider === 'zhipu-coding') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getPromaUserAgent(pkg.version)
  } else if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getPromaUserAgent(pkg.version)
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers,
  })

  if (response.status === 401) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}`, models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { data?: AnthropicModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.display_name || item.id,
    enabled: true,
  }))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

/**
 * OpenAI 兼容 API 模型响应项
 */
interface OpenAIModelItem {
  id: string
  owned_by?: string
}

/**
 * 从 OpenAI 兼容 API 拉取模型列表（OpenAI / Custom）
 *
 * API: GET {baseUrl}/models
 * 通用 OpenAI 兼容格式，适用于大部分第三方供应商。
 */
async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { data?: OpenAIModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.id,
    enabled: true,
  }))

  // 按模型 ID 字母排序，方便用户查找
  models.sort((a, b) => a.id.localeCompare(b.id))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

/**
 * Google Generative AI 模型响应项
 */
interface GoogleModelItem {
  name: string
  displayName?: string
  description?: string
  supportedGenerationMethods?: string[]
}

/**
 * 从 Google Generative AI API 拉取模型列表
 *
 * API: GET /v1beta/models?key={apiKey}
 * 仅返回支持 generateContent 的模型（排除纯 embedding 模型）。
 */
async function fetchGoogleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = await response.json() as { models?: GoogleModelItem[] }
  const items = data.models ?? []

  // 过滤出支持 generateContent 的模型（排除纯 embedding 模型）
  const chatModels = items.filter((item) =>
    item.supportedGenerationMethods?.includes('generateContent')
  )

  const models: ChannelModel[] = chatModels.map((item) => {
    // Google 模型 name 格式为 "models/gemini-pro"，提取实际 ID
    const id = item.name.replace(/^models\//, '')
    return {
      id,
      name: item.displayName || id,
      enabled: true,
    }
  })

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}
