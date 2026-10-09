/**
 * 渠道管理器
 *
 * 负责渠道的 CRUD 操作、API Key 加密/解密、连接测试。
 * 使用 Electron safeStorage 进行 API Key 加密（底层使用 OS 级加密）。
 * 数据持久化到 ~/.proma/channels.json。
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJsonFileAtomic } from './safe-file'
import { getChannelsPath } from './config-paths'
import { encryptToken, decryptToken } from './token-crypto'
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelsConfig,
  ChannelTestResult,
  ChannelModel,
  CodexOAuthCredentials,
  FetchModelsInput,
  FetchModelsResult,
  ProviderType,
  XaiOAuthCredentials,
} from '@profer/shared'
import { PROVIDER_CAPABILITIES, PROVIDER_DEFAULT_URLS, extractZhipuCodingTeamApiToken, isAgentEnabledForChannel, isCodexCredentialExpired, isXaiCredentialExpired, parseCodexCredentials, parseXaiCredentials, resolveProviderNativeProtocol, resolveXaiCredentialMode, serializeCodexCredentials, serializeXaiCredentials, supportsProviderPlanQuota } from '@profer/shared'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { assertSdkBaseUrlSupportsRouting, isAnthropicShapedEndpoint, resolveAnthropicMessagesUrl, resolveAnthropicModelsUrl, resolveOpenAIChatCompletionsUrl, resolveOpenAIResponsesUrl, resolveOpenAIModelsUrl, getProferUserAgent } from '@profer/core'
import { parseMiniMaxGeneralQuotaWindows } from './channel-plan-quota-parsers'
import { parseCodexPlanQuotaResponse } from './codex-plan-quota'
import { loginCodexOAuth, refreshCodexOAuth } from './codex-oauth-service'
import { refreshXaiOAuth } from './xai-oauth-service'
import { refreshXaiOAuthCredentialsSerial, rememberXaiOAuthCredentials } from './xai-oauth-credentials'
import { isCommercialBuild } from './build-target'
import { isOfficialManagedChannel } from './official-channel'
import {
  inferAgentBaseUrl,
  normalizeChannelForCurrentSchema,
  normalizeConfigForCurrentSchema,
} from './channel-url-routing'
import pkg from '../../../package.json' with { type: 'json' }

/** 当前配置版本 */
const CONFIG_VERSION = 1

/** 渠道测试请求超时（毫秒） */
const CHANNEL_TEST_TIMEOUT_MS = 15_000

/** 订阅 Plan / 余额查询超时（毫秒）。余额是 hover 触发的轻量查询，
 * 不应复用连通性测试的 15s 超时，否则网络抖动时用户会卡很久转圈 */
const PLAN_QUOTA_TIMEOUT_MS = 5_000

const GLM_53_PRESET_MODEL_UPDATE_ID = 'glm-5.3-candidates-v1'
const GLM_53_PRESET_MODEL_CANDIDATES: Partial<Record<ProviderType, readonly ChannelModel[]>> = {
  zhipu: [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
  'zhipu-coding': [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
  'zhipu-coding-team': [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
  doubao: [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
  'opencode-go-openai': [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
  'ark-coding-plan': [{ id: 'glm-5.3', name: 'GLM-5.3', enabled: false }],
}

function cloneModels(models: readonly ChannelModel[]): ChannelModel[] {
  return models.map((model) => ({ ...model }))
}

/** Adds a new preset candidate only once, preserving existing channel/model enablement. */
export function applyPresetModelCandidateUpdates(config: ChannelsConfig): { config: ChannelsConfig; changed: boolean } {
  const appliedUpdates = new Set(config.appliedPresetModelUpdates ?? [])
  if (appliedUpdates.has(GLM_53_PRESET_MODEL_UPDATE_ID)) return { config, changed: false }

  let changed = false
  const channels = config.channels.map((channel) => {
    const candidates = GLM_53_PRESET_MODEL_CANDIDATES[channel.provider]
    if (!candidates) return channel

    const existingModelIds = new Set(channel.models.map((model) => model.id))
    const missingCandidates = candidates.filter((model) => !existingModelIds.has(model.id))
    if (missingCandidates.length === 0) return channel

    changed = true
    return { ...channel, models: [...channel.models, ...cloneModels(missingCandidates)] }
  })

  appliedUpdates.add(GLM_53_PRESET_MODEL_UPDATE_ID)
  return {
    config: { ...config, channels, appliedPresetModelUpdates: [...appliedUpdates] },
    changed: changed || !config.appliedPresetModelUpdates?.includes(GLM_53_PRESET_MODEL_UPDATE_ID),
  }
}

function withTimeout(init: RequestInit, timeoutMs: number = CHANNEL_TEST_TIMEOUT_MS): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs)
  return { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout }
}

/** 余额/额度查询专用：短超时，快速失败 */
function withPlanQuotaTimeout(init: RequestInit): RequestInit {
  return withTimeout(init, PLAN_QUOTA_TIMEOUT_MS)
}

export function resolveChannelAgentBaseUrl(channel: Pick<Channel, 'provider' | 'baseUrl' | 'agentBaseUrl'>): string | undefined {
  return inferAgentBaseUrl(channel.provider, channel.baseUrl, channel.agentBaseUrl)
}

/**
 * Chat 抓取器/测试器分派：把 provider 归类到具体请求实现。
 * 规则与能力描述符 chatProtocol 对齐（单一事实源），三处 switch（testChannel /
 * testChannelDirect / fetchModels）共用，不再各写一份 provider 枚举。
 * ollama 与 google 有独立实现，单列；deepseek 走 OpenAI 兼容（chatProtocol=openai）。
 */
type ChatAdapterKind = 'anthropic' | 'openai' | 'google' | 'ollama' | 'unsupported'
function resolveChatAdapterKind(provider: ProviderType): ChatAdapterKind {
  // openai-codex 走 OAuth 内置目录，没有可用的 vendor Chat/抓取 API，原 switch
  // 落 default 返回「不支持」；分派表保持这个行为。
  if (provider === 'openai-codex') return 'unsupported'
  if (provider === 'ollama') return 'ollama'
  if (provider === 'google') return 'google'
  return PROVIDER_CAPABILITIES[provider].chatProtocol === 'anthropic' ? 'anthropic' : 'openai'
}

/**
 * 合并服务端下发的渠道模型与本地状态。
 *
 * 服务端只负责「有哪些模型」，以下两项属于用户本地决定，不得被同步洗掉：
 * - 模型级 enabled（用户启停）
 * - 模型上的 1M 勾选（context1m）
 */
export function mergeServerChannelModels(
  serverModels: readonly Partial<ChannelModel>[],
  localModels: readonly ChannelModel[] | undefined,
): ChannelModel[] {
  return serverModels.map((model) => {
    const modelKey = model.id ?? model.name
    const localModel = localModels?.find((candidate) => candidate.id === modelKey)
    return {
      ...model,
      enabled: localModel ? localModel.enabled : model.enabled !== false,
      ...(localModel?.context1m !== undefined && { context1m: localModel.context1m }),
    } as ChannelModel
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 先校验再迁移，结构损坏不得伪装成空配置并覆盖原文件。 */
function assertChannelsConfig(value: unknown): asserts value is ChannelsConfig {
  if (!isRecord(value) || value.version !== CONFIG_VERSION || !Array.isArray(value.channels)
    || (value.appliedPresetModelUpdates !== undefined && (!Array.isArray(value.appliedPresetModelUpdates)
      || value.appliedPresetModelUpdates.some((item) => typeof item !== 'string')))) {
    throw new Error('渠道配置结构无效')
  }
  const ids = new Set<string>()
  for (const channel of value.channels) {
    if (!isRecord(channel) || typeof channel.id !== 'string' || !channel.id || ids.has(channel.id)
      || typeof channel.name !== 'string' || typeof channel.provider !== 'string'
      || !Object.hasOwn(PROVIDER_DEFAULT_URLS, channel.provider)
      || typeof channel.baseUrl !== 'string' || typeof channel.apiKey !== 'string'
      || typeof channel.enabled !== 'boolean' || !Array.isArray(channel.models)
      || typeof channel.createdAt !== 'number' || !Number.isFinite(channel.createdAt)
      || typeof channel.updatedAt !== 'number' || !Number.isFinite(channel.updatedAt)
      || (channel.serverManaged !== undefined && typeof channel.serverManaged !== 'boolean')
      || (channel.agentBaseUrl !== undefined && typeof channel.agentBaseUrl !== 'string')
      || (channel.agentRuntimes !== undefined && (!Array.isArray(channel.agentRuntimes)
        || channel.agentRuntimes.some((mode) => mode !== 'pi' && mode !== 'claude')))
      || (channel.credentialMode !== undefined && channel.credentialMode !== 'oauth' && channel.credentialMode !== 'api-key')
      || (channel.agentExperimentalEnabled !== undefined && typeof channel.agentExperimentalEnabled !== 'boolean')) {
      throw new Error('渠道配置包含无效渠道')
    }
    ids.add(channel.id)
    const modelIds = new Set<string>()
    for (const model of channel.models) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id || modelIds.has(model.id)
        || typeof model.name !== 'string' || typeof model.enabled !== 'boolean'
        || (model.context1m !== undefined && typeof model.context1m !== 'boolean')
        || (model.source !== undefined && model.source !== 'manual' && model.source !== 'fetched')) {
        throw new Error('渠道配置包含无效模型')
      }
      modelIds.add(model.id)
    }
  }
}

/**
 * 读取渠道配置文件
 */
function readConfig(): ChannelsConfig {
  const configPath = getChannelsPath()

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: CONFIG_VERSION, channels: [] }
    throw new Error('读取渠道配置失败，已中止操作以保留原文件')
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    assertChannelsConfig(parsed)
    const normalized = normalizeConfigForCurrentSchema(parsed)
    const channelsWithCredentialModes = normalized.config.channels.map((channel) => {
      if (channel.provider !== 'xai' || channel.credentialMode) return channel
      try {
        return { ...channel, credentialMode: resolveXaiCredentialMode(undefined, decryptKey(channel.apiKey)) }
      } catch {
        return channel
      }
    })
    const credentialModeChanged = channelsWithCredentialModes.some((channel, index) => channel !== normalized.config.channels[index])
    const presetUpdated = applyPresetModelCandidateUpdates({ ...normalized.config, channels: channelsWithCredentialModes })
    if (normalized.changed || credentialModeChanged || presetUpdated.changed) {
      try {
        writeConfig(presetUpdated.config)
        console.log('[渠道管理] 已应用渠道配置迁移或预设模型更新')
      } catch (error) {
        console.warn('[渠道管理] 写入迁移后的渠道配置失败，将继续使用内存中的迁移结果:', error)
      }
    }
    return presetUpdated.config
  } catch {
    console.error('[渠道管理] 读取配置文件失败：内容损坏或格式不受支持')
    throw new Error('渠道配置损坏或格式不受支持，已中止操作以保留原文件')
  }
}

/**
 * 写入渠道配置文件
 */
function writeConfig(config: ChannelsConfig): void {
  const configPath = getChannelsPath()

  try {
    assertChannelsConfig(config)
    writeJsonFileAtomic(configPath, config)
  } catch (error) {
    console.error('[渠道管理] 写入配置文件失败:', error)
    throw new Error('写入渠道配置失败')
  }
}

/**
 * 加密 API Key
 *
 * 使用 Electron safeStorage 加密（底层使用 OS 级加密）。
 * safeStorage 不可用时自动降级到 AES-256-GCM（deviceId 派生密钥）。
 *
 * @returns base64 编码的加密字符串
 */
function encryptApiKey(plainKey: string): string {
  return encryptToken(plainKey)
}

/**
 * 解密 API Key
 *
 * @param encryptedKey base64 编码的加密字符串
 * @returns 明文 API Key
 */
function decryptKey(encryptedKey: string): string {
  return decryptToken(encryptedKey)
}

/**
 * 登出渠道备份文件的路径（按账号隔离）。
 * 备份/恢复/校验共用此函数，避免文件名拼写漂移。
 */
export function getChannelsLogoutBackupPath(accountId: string): string {
  const safeId = accountId.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${getChannelsPath()}.logout-backup-${safeId}`
}

/** 登出备份只保存用户自配渠道，官方渠道由登录后的服务端同步重新生成。 */
export function getUserManagedChannelsForLogout(channels: Channel[]): Channel[] {
  return channels.filter((channel) => !isOfficialManagedChannel(channel))
}

/**
 * 将当前渠道配置加密备份到磁盘（按账号隔离）
 *
 * logout 时调用：把整个 channels.json（含渠道元数据）用 token-crypto 整体加密后
 * 写入 channels.json.logout-backup-{accountId}。加密密钥由 deviceId 派生
 * （注册表/Keychain，仅当前用户可读），其他用户/进程拿到备份文件也无法解密。
 *
 * 安全语义：**备份必须成功，失败一律抛错**，由调用方决定是否继续清空活跃文件。
 * 绝不静默吞掉失败——否则「重登恢复」会因无备份而丢渠道。
 *
 * @returns 写出的备份文件绝对路径；无渠道/无文件时返回 null
 * @throws 加密失败/写盘失败/写回校验失败时抛错，调用方应据此中止清空活跃渠道
 */
export function backupChannelsForAccount(accountId: string | undefined | null): string | null {
  const configPath = getChannelsPath()
  if (!existsSync(configPath)) return null

  const raw = readFileSync(configPath, 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  assertChannelsConfig(parsed)
  const userManagedChannels = getUserManagedChannelsForLogout(parsed.channels || [])
  if (userManagedChannels.length === 0) {
    // 无自配渠道时无需备份，也不应视为失败（清空官方渠道无损失）
    return null
  }
  if (!accountId) {
    throw new Error('无法获取账号标识，无法为渠道创建隔离备份')
  }

  const backupPath = getChannelsLogoutBackupPath(accountId)
  const backupConfig: ChannelsConfig = {
    ...parsed,
    channels: userManagedChannels,
  }
  const encrypted = encryptToken(JSON.stringify(backupConfig))
  if (!encrypted || encrypted.length === 0) {
    throw new Error('渠道加密备份生成为空，已中止（避免覆盖丢失）')
  }

  writeFileSync(backupPath, encrypted, 'utf-8')

  // 写回校验：确认备份确实落盘且非空，杜绝「以为备份了其实没写进去」
  const verified = readFileSync(backupPath, 'utf-8')
  if (!verified || verified.length === 0) {
    throw new Error('渠道备份写回校验失败（文件为空），已中止清空')
  }

  console.log(`[渠道管理] 已为账号 ${accountId.replace(/[^A-Za-z0-9._-]/g, '_')} 加密备份 ${userManagedChannels.length} 个自配渠道 → ${backupPath}`)
  return backupPath
}

/**
 * 渠道恢复结果
 */
export interface RestoreChannelsResult {
  /** 恢复的渠道数量（0 = 无备份、已跳过或恢复失败） */
  restored: number
  /** 非 0 时表示发生了需要用户知晓的问题 */
  error?: string
  /** 备份文件是否保留在磁盘（失败时为 true，便于二次抢救） */
  backupRetained: boolean
}

/**
 * 从加密备份恢复渠道配置（按账号隔离）
 *
 * login 成功后调用：仅当 channels.json 为空时才恢复对应账号的备份，
 * 避免覆盖用户已有配置；恢复成功且落盘后才删除备份文件。
 * 任何失败（解密/解析/落盘）都**保留备份文件**，不静默丢弃，便于用户二次抢救。
 */
export function restoreChannelsForAccount(accountId: string): RestoreChannelsResult {
  const backupPath = getChannelsLogoutBackupPath(accountId)
  if (!existsSync(backupPath)) {
    return { restored: 0, backupRetained: false }
  }

  let encrypted: string
  try {
    encrypted = readFileSync(backupPath, 'utf-8')
  } catch (err) {
    return { restored: 0, error: `读取渠道备份失败: ${(err as Error).message}`, backupRetained: true }
  }

  let raw: string
  try {
    raw = decryptToken(encrypted)
  } catch (err) {
    return { restored: 0, error: `渠道备份解密失败（已保留备份文件供抢救）: ${(err as Error).message}`, backupRetained: true }
  }

  let parsed: ChannelsConfig
  try {
    parsed = JSON.parse(raw) as ChannelsConfig
    assertChannelsConfig(parsed)
  } catch (err) {
    return { restored: 0, error: `渠道备份解析失败（已保留备份文件供抢救）: ${(err as Error).message}`, backupRetained: true }
  }

  const backedUpChannels = getUserManagedChannelsForLogout(parsed.channels || [])
  if (backedUpChannels.length === 0) {
    // 兼容旧版“整份配置备份”：解密确认有效后清理仅含官方渠道的旧备份。
    rmSync(backupPath, { force: true })
    return { restored: 0, backupRetained: false }
  }

  // 合并而不是要求当前配置完全为空：登录其他账号后，官方渠道可能已先同步到本地，
  // 不能因此阻断原账号自配渠道的恢复。已有同 ID 渠道不覆盖。
  let current: ChannelsConfig
  try {
    current = readConfig()
  } catch {
    return { restored: 0, error: '本地渠道配置无法读取（已保留原文件和备份）', backupRetained: true }
  }
  const existingIds = new Set(current.channels.map((channel) => channel.id))
  const channelsToRestore = backedUpChannels.filter((channel) => !existingIds.has(channel.id))
  if (channelsToRestore.length === 0) {
    // 备份中的渠道已经存在，删除重复备份，避免每次登录都重复提示/扫描。
    rmSync(backupPath, { force: true })
    return { restored: 0, backupRetained: false }
  }

  // 落盘成功后才删备份：写入失败时备份仍留在磁盘
  try {
    writeConfig({ ...current, channels: [...current.channels, ...channelsToRestore] })
  } catch (err) {
    return { restored: 0, error: `渠道备份写入本地失败（已保留备份文件供抢救）: ${(err as Error).message}`, backupRetained: true }
  }
  rmSync(backupPath, { force: true })
  console.log(`[渠道管理] 已从加密备份恢复 ${channelsToRestore.length} 个自配渠道 → ${backupPath}`)
  return { restored: channelsToRestore.length, backupRetained: false }
}

/**
 * 从服务端同步渠道到本地
 *
 * 仅商业模式下调用。拉取服务端渠道 → 加密 API Key → 覆盖本地 channels.json。
 * 同时备份旧配置到 channels.json.server-backup。
 */
export async function syncChannelsFromServer(serverBaseUrl: string, accessToken: string): Promise<boolean> {
  // 记录请求发起时的账号身份。登出后旧请求即使返回成功，也不得把官方渠道写回本地。
  const { getTeamAuth, getAuthSessionGeneration } = require('./auth-service') as typeof import('./auth-service')
  const generationAtStart = getAuthSessionGeneration()
  const authAtStart = getTeamAuth()
  if (generationAtStart === null || !authAtStart || authAtStart.baseUrl !== serverBaseUrl || authAtStart.teamAccountId === undefined
    || authAtStart.token !== accessToken) {
    throw new Error('渠道同步已跳过：当前团队会话已失效')
  }
  const accountIdAtStart = authAtStart.teamAccountId

  const fetchFn = await getFetchFn()
  const url = `${serverBaseUrl}/v1/account/channels`

  const resp = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!resp.ok) {
    throw new Error(`渠道同步失败: HTTP ${resp.status}`)
  }

  const data = await resp.json() as {
    commercialMode: boolean
    channels: Array<{
      id: string
      name: string
      provider: string
      apiKey: string
      baseUrl: string
      agentBaseUrl?: string
      managedType?: 'model-family' | 'legacy'
      familyId?: string
      directDataPlane?: boolean
      models: ChannelModel[]
    }>
  }

  if (!data.commercialMode || !data.channels) return false

  // 请求期间可能发生登出或切换账号；再次校验账号后再落盘，避免旧响应污染新会话。
  const authBeforeWrite = getTeamAuth()
  if (!authBeforeWrite || authBeforeWrite.baseUrl !== serverBaseUrl || authBeforeWrite.teamAccountId !== accountIdAtStart
    || authBeforeWrite.token !== authAtStart.token
    || generationAtStart !== getAuthSessionGeneration()) {
    throw new Error('渠道同步已跳过：请求完成时团队会话已变化')
  }

  // 防止空列表雪崩：服务端返回 0 条渠道时跳过同步，保留现有本地缓存。
  // 空结果通常是服务端异常导致，不应将客户端全部渠道清空。
  if (data.channels.length === 0) {
    console.warn('[渠道管理] 服务端返回空渠道列表，跳过同步以保留现有渠道')
    return false
  }

  const existingConfig = readConfig()
  // 备份旧配置
  const configPath = getChannelsPath()
  if (existsSync(configPath)) {
    try {
      const backupPath = configPath + '.server-backup'
      writeFileSync(backupPath, readFileSync(configPath))
    } catch { /* 备份失败不致命 */ }
  }

  // 将服务端渠道写入本地，保留用户自建的本地渠道
  const serverIds = new Set(data.channels.map((ch) => ch.id))

  // 清理已不在服务端列表中的 serverManaged 渠道（服务端已删除的渠道）
  const preCleanupCount = existingConfig.channels.length
  const localChannels = existingConfig.channels.filter((c) => {
    if (serverIds.has(c.id)) return false // 服务端仍在管理，后面会用最新数据覆盖
    if (isOfficialManagedChannel(c)) return false // 之前由服务端管理但现在不在列表中了 → 已删除，清理
    return true // 用户自建本地渠道，保留
  })
  const cleanedCount = preCleanupCount - localChannels.length - serverIds.size
  if (cleanedCount > 0) {
    console.log(`[渠道管理] 清理了 ${cleanedCount} 个服务端已删除的渠道`)
  }

  const now = Date.now()
  const config: ChannelsConfig = { version: 1, channels: [...localChannels] }

  for (const ch of data.channels) {
    // 本地已有同 ID 渠道时：保留用户启停状态（enabled + 模型级 enabled）与模型上的 1M 偏好，
    // 否则一次服务端同步就会把用户在渠道配置里的 1M 勾选洗掉。
    const localExisting = existingConfig.channels.find((c) => c.id === ch.id)
    const mergedModels = mergeServerChannelModels(ch.models, localExisting?.models)
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
      managedType: ch.managedType ?? 'legacy',
      familyId: ch.familyId,
      directDataPlane: ch.directDataPlane === true,
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
        const agentCapableChannels = config.channels.filter((c) => isAgentEnabledForChannel(c))
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
  // 所有同步入口（启动、续期、LIST、恢复）共用完成通知；不广播凭据或配置正文。
  const { agentCatalogInvalidationPublisher } = require('./agent-service') as typeof import('./agent-service')
  agentCatalogInvalidationPublisher.invalidate('channels')
  return true
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
 *
 * 渠道与模型只来自「用户自配」或「服务端下发」两种来源：这里不生成任何占位渠道，
 * 也不预置模型清单——替用户假设他要使用某个供应商，会让他看到从未配置过的渠道，
 * 并让预置清单冒充真实的端点能力。模型清单由渠道表单从供应商端点发现后写入。
 */
export function listChannels(): Channel[] {
  return readConfig().channels
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
  if (input.provider === 'xai' && input.credentialMode === 'oauth' && !parseXaiCredentials(input.apiKey)) {
    throw new Error('xAI OAuth 渠道必须先完成订阅登录')
  }
  const config = readConfig()
  const now = Date.now()

  const rawChannel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    ...(input.provider === 'xai' && input.credentialMode ? { credentialMode: input.credentialMode } : {}),
    ...(input.provider === 'xai' && input.agentExperimentalEnabled ? { agentExperimentalEnabled: true } : {}),
    agentBaseUrl: input.agentBaseUrl,
    ...(input.agentRuntimes ? { agentRuntimes: input.agentRuntimes } : {}),
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
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)
  if (index === -1) throw new Error(`渠道不存在: ${id}`)
  const existing = config.channels[index]!

  // 官方同步渠道（newapi-*）：允许切换 channel enabled + 模型 enabled，不允许改名称/供应商/API Key/增删模型
  if (isOfficialManagedChannel(existing)) {
    if (input.name !== undefined || input.provider !== undefined ||
        input.baseUrl !== undefined || input.agentBaseUrl !== undefined ||
        input.agentRuntimes !== undefined ||
        input.credentialMode !== undefined || input.agentExperimentalEnabled !== undefined ||
        input.apiKey !== undefined) {
      throw new Error('官方渠道由平台统一管理，不可修改')
    }
    if (input.models !== undefined) {
      if (existing.models.length !== input.models.length || input.models.some((model) => {
        const old = existing.models.find((candidate) => candidate.id === model.id)
        if (!old) return true
        const keys = new Set([...Object.keys(old), ...Object.keys(model)])
        for (const key of keys) {
          if (key !== 'enabled' && key !== 'context1m'
            && Reflect.get(old, key) !== Reflect.get(model, key)) return true
        }
        return false
      })) {
        throw new Error('官方渠道不可修改模型目录，仅可控制启用/停用和 1M 偏好')
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
      input.agentRuntimes !== undefined ||
      input.credentialMode !== undefined ||
      input.agentExperimentalEnabled !== undefined ||
      input.apiKey !== undefined ||
      (input.models !== undefined && !isOfficialManagedChannel(existing))
    if (hasStructuralChange) {
      throw new Error('商业模式下不允许修改渠道，渠道由服务端统一管理')
    }
  }
  const targetProvider = input.provider ?? existing.provider
  // 普通字段更新不依赖解密成功；损坏凭据也允许用户替换，而不是二次加密旧密文。
  if (targetProvider === 'xai' && (input.apiKey
    || (input.credentialMode !== undefined && input.credentialMode !== existing.credentialMode)
    || targetProvider !== existing.provider)) {
    const existingSecret = !input.apiKey && existing.provider === 'xai' ? decryptKey(existing.apiKey) : ''
    const targetMode = input.credentialMode ?? existing.credentialMode
    if (targetMode === 'oauth' && !parseXaiCredentials(input.apiKey || existingSecret)) {
      throw new Error('xAI OAuth 渠道必须先完成订阅登录')
    }
    if (targetMode === 'api-key'
      && existing.provider === 'xai'
      && resolveXaiCredentialMode(existing.credentialMode, existingSecret) === 'oauth'
      && !input.apiKey?.trim()) {
      throw new Error('从 xAI 订阅切换到 API Key 前，请填写新的 xAI API Key')
    }
  }

  // Agent URL 属于按 Base URL 推导的派生值，历史实现把它单独持久化。若用户改了
  // Base URL / 供应商但没显式指定 Agent URL，继续保留旧值会让 Agent 请求打到
  // 上一个地址（典型现象：换了 Base URL 后 Agent 依旧请求不到）。此处丢弃派生值，
  // 交给 normalizeChannelForCurrentSchema 按新配置重新推导。
  const nextProvider = input.provider ?? existing.provider
  const nextBaseUrl = input.baseUrl ?? existing.baseUrl
  const endpointChanged = nextProvider !== existing.provider || nextBaseUrl !== existing.baseUrl
  const nextAgentBaseUrl = input.agentBaseUrl !== undefined
    ? input.agentBaseUrl
    : endpointChanged
      ? undefined
      : existing.agentBaseUrl

  const rawUpdated: Channel = {
    ...existing,
    name: input.name ?? existing.name,
    provider: nextProvider,
    baseUrl: nextBaseUrl,
    ...(nextProvider === 'xai'
      ? { credentialMode: input.credentialMode ?? existing.credentialMode, agentExperimentalEnabled: input.agentExperimentalEnabled ?? existing.agentExperimentalEnabled }
      : { credentialMode: undefined, agentExperimentalEnabled: undefined }),
    agentBaseUrl: nextAgentBaseUrl,
    // 未显式传入时保留原勾选；老配置的推导由 normalizeChannelForCurrentSchema 负责。
    agentRuntimes: input.agentRuntimes !== undefined ? input.agentRuntimes : existing.agentRuntimes,
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
  if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下不允许删除渠道，渠道由服务端统一管理')
  const config = readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  if (isOfficialManagedChannel(config.channels[index]!)) throw new Error('官方同步渠道不可删除，请在 New API 后台管理')
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

let inflightCodexLogin: Promise<Channel> | undefined

/** 授权前不落盘；失败/取消无孤儿渠道，同一时刻拒绝重复登录或创建。 */
export async function loginCodexChannel(input: import('@profer/shared').CodexOAuthLoginInput): Promise<Channel> {
  if (inflightCodexLogin) throw new Error('Codex 登录正在进行，请先完成或取消')
  if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下不允许自配 Codex 渠道')
  if (typeof input === 'string') {
    const channel = getChannelById(input)
    if (!channel || channel.provider !== 'openai-codex' || isOfficialManagedChannel(channel)) {
      throw new Error('Codex 渠道不存在或不可重新授权')
    }
  } else if (!input || !input.name.trim() || !input.models.some((model) => model.enabled)) {
    throw new Error('请填写渠道名称并至少启用一个 Codex 模型')
  }
  const operation = (async () => {
    const credentials = await loginCodexOAuth()
    if (typeof input === 'string') {
      const current = getChannelById(input)
      if (!current || current.provider !== 'openai-codex' || isOfficialManagedChannel(current)) {
        throw new Error('Codex 渠道已删除或类型改变，请重新选择渠道')
      }
    }
    if (typeof input !== 'string') {
      return createChannel({ ...input, provider: 'openai-codex', apiKey: serializeCodexCredentials(credentials) })
    }
    updateChannel(input, { apiKey: serializeCodexCredentials(credentials) })
    const updated = getChannelById(input)
    if (!updated) throw new Error('Codex 登录完成，但渠道读取失败')
    return updated
  })()
  inflightCodexLogin = operation
  try {
    return await operation
  } finally {
    if (inflightCodexLogin === operation) inflightCodexLogin = undefined
  }
}

/**
 * 进行中的 codex token 刷新（按 channelId 去重）。
 *
 * 多个 Agent 会话可能并发触发同一渠道的 token 刷新；若不去重会造成对
 * OpenAI token 端点的重复请求，且后写覆盖先写。此 Map 保证同一渠道同一时刻
 * 只有一次刷新在飞行，其余调用复用同一 Promise。
 */
const inflightCodexRefresh = new Map<string, Promise<CodexOAuthCredentials>>()

/** 保存 Pi 或 Profer 刷新后的完整 Codex OAuth 凭据。 */
export function persistCodexOAuthCredentials(channelId: string, credentials: CodexOAuthCredentials): void {
  const channel = getChannelById(channelId)
  if (!channel || channel.provider !== 'openai-codex') {
    throw new Error(`Codex 渠道不存在或类型不匹配: ${channelId}`)
  }

  const existing = parseCodexCredentials(decryptKey(channel.apiKey))
  const merged = {
    ...credentials,
    accountId: credentials.accountId ?? existing?.accountId,
  }
  updateChannel(channelId, { apiKey: serializeCodexCredentials(merged) })
}

/**
 * 解析渠道存储的 ChatGPT (Codex) OAuth 凭据，按需刷新并回写。
 * Pi runtime 必须接收完整 credential，才能在长时间运行时按真实 expires 刷新 token。
 */
export async function resolveCodexOAuthCredentials(channelId: string): Promise<CodexOAuthCredentials> {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)
  if (!channel) {
    throw new Error(`渠道不存在: ${channelId}`)
  }

  const credentials = parseCodexCredentials(decryptKey(channel.apiKey))
  if (!credentials) {
    throw new Error('ChatGPT 登录凭据无效或缺失，请重新登录')
  }

  if (!isCodexCredentialExpired(credentials)) {
    return credentials
  }

  const existing = inflightCodexRefresh.get(channelId)
  if (existing) return existing

  const refreshPromise = (async (): Promise<CodexOAuthCredentials> => {
    try {
      const refreshed = await refreshCodexOAuth(credentials.refresh)
      const merged = {
        ...refreshed,
        accountId: refreshed.accountId ?? credentials.accountId,
      }
      persistCodexOAuthCredentials(channelId, merged)
      return merged
    } finally {
      inflightCodexRefresh.delete(channelId)
    }
  })()

  inflightCodexRefresh.set(channelId, refreshPromise)
  return refreshPromise
}

/** 返回当前有效的 Codex access token，兼容只需要 bearer token 的调用方。 */
export async function resolveCodexAccessToken(channelId: string): Promise<string> {
  return (await resolveCodexOAuthCredentials(channelId)).access
}

let inflightXaiLogin: Promise<Channel> | undefined

/** xAI 授权事务：授权前不落盘，重试不留下孤儿渠道，已有渠道原位更新。 */
export async function loginXaiChannel(input: import('@profer/shared').XaiOAuthLoginInput): Promise<Channel> {
  if (inflightXaiLogin) throw new Error('xAI 登录正在进行，请先完成或取消')
  if (isCommercialMode() && !canSelfConfig()) throw new Error('商业模式下不允许自配 xAI 渠道')
  if (typeof input === 'string') {
    const channel = getChannelById(input)
    if (!channel || channel.provider !== 'xai' || isOfficialManagedChannel(channel)) {
      throw new Error('xAI 渠道不存在或不可重新授权')
    }
  } else if (!input || !input.name.trim() || !input.models.some((model) => model.enabled)) {
    throw new Error('请填写渠道名称并至少启用一个 xAI 模型')
  }
  const operation = (async () => {
    const { loginXaiOAuth } = await import('./xai-oauth-service')
    const credentials = await loginXaiOAuth()
    if (typeof input !== 'string') {
      const channel = createChannel({ ...input, provider: 'xai', credentialMode: 'oauth', apiKey: serializeXaiCredentials(credentials) })
      rememberXaiOAuthCredentials(channel.id, credentials, true)
      return channel
    }
    const current = getChannelById(input)
    if (!current || current.provider !== 'xai' || isOfficialManagedChannel(current)) {
      throw new Error('xAI 渠道已删除或类型改变，请重新选择渠道')
    }
    persistXaiOAuthCredentials(input, credentials)
    const updated = getChannelById(input)
    if (!updated) throw new Error('xAI 登录完成，但渠道读取失败')
    return updated
  })()
  inflightXaiLogin = operation
  try {
    return await operation
  } finally {
    if (inflightXaiLogin === operation) inflightXaiLogin = undefined
  }
}

/** 保存 Pi 或 Profer 刷新后的完整 xAI OAuth 凭据。 */
export function persistXaiOAuthCredentials(channelId: string, credentials: XaiOAuthCredentials): void {
  const channel = getChannelById(channelId)
  if (!channel || channel.provider !== 'xai') {
    throw new Error(`xAI 渠道不存在或类型不匹配: ${channelId}`)
  }
  updateChannel(channelId, { apiKey: serializeXaiCredentials(credentials), credentialMode: 'oauth' })
  rememberXaiOAuthCredentials(channelId, credentials, true)
}

/** 解析 xAI（Grok/X 订阅）凭据，按 expiry 刷新并回写加密渠道存储。 */
export async function resolveXaiOAuthCredentials(channelId: string): Promise<XaiOAuthCredentials> {
  const config = readConfig()
  const channel = config.channels.find((c) => c.id === channelId)
  if (!channel || channel.provider !== 'xai') {
    throw new Error('xAI 订阅渠道不存在或类型不匹配')
  }
  const credentials = parseXaiCredentials(decryptKey(channel.apiKey))
  if (!credentials) throw new Error('xAI 登录凭据无效或缺失，请重新登录')
  if (!isXaiCredentialExpired(credentials)) {
    return rememberXaiOAuthCredentials(channelId, credentials)
  }

  const refreshed = await refreshXaiOAuthCredentialsSerial(
    channelId,
    credentials,
    (current) => refreshXaiOAuth(current.refresh),
  )
  persistXaiOAuthCredentials(channelId, refreshed)
  return refreshed
}

export async function resolveXaiAccessToken(channelId: string): Promise<string> {
  return (await resolveXaiOAuthCredentials(channelId)).access
}

/**
 * 解析渠道运行时实际使用的认证 token。
 *
 * 普通渠道直接解密 API Key；ChatGPT (Codex) OAuth 渠道的 apiKey 字段存储的是
 * OAuth 凭据 JSON，运行时必须取出 access token 并按需刷新。
 */
export async function resolveChannelRuntimeApiKey(channelId: string): Promise<string> {
  const channel = getChannelById(channelId)
  if (!channel) {
    throw new Error(`渠道不存在: ${channelId}`)
  }

  if (channel.provider === 'openai-codex') return resolveCodexAccessToken(channelId)
  if (channel.provider === 'xai') {
    const secret = decryptKey(channel.apiKey)
    return resolveXaiCredentialMode(channel.credentialMode, secret) === 'oauth'
      ? resolveXaiAccessToken(channelId)
      : secret
  }
  return decryptApiKey(channelId)
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
  if (channel.provider === 'xai' && resolveXaiCredentialMode(channel.credentialMode, apiKey) === 'oauth') {
    return { success: false, message: 'xAI 订阅 OAuth 不支持 API Key 连接测试，请使用 Pi Agent 实验模式' }
  }
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    // ollama 无独立测试实现，沿用 Anthropic 兼容测试（与原 switch 一致）。
    const adapterKind = channel.provider === 'ollama' ? 'anthropic' : resolveChatAdapterKind(channel.provider)
    switch (adapterKind) {
      case 'anthropic':
        return await testAnthropicCompatible(channel.baseUrl, apiKey, proxyUrl, channel.provider)
      case 'openai':
        return await testOpenAICompatible(channel.baseUrl, apiKey, proxyUrl)
      case 'google':
        return await testGoogle(channel.baseUrl, apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${channel.provider}。你可能过去使用的是 Profer 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

/**
 * 测试 Anthropic 兼容 API 连接（Anthropic / DeepSeek / Kimi API / Kimi Coding Plan / MiniMax）
 *
 * 未指定模型时只校验目录；指定模型时调用真实的 Messages 端点。
 * Kimi Coding Plan 必须发送 Profer User-Agent，否则返回 403。
 */
async function testAnthropicCompatible(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
  modelId?: string,
  signal?: AbortSignal,
): Promise<ChannelTestResult> {
  if (!modelId?.trim()) {
    const result = provider === 'ollama'
      ? await fetchOllamaModels(baseUrl, apiKey, proxyUrl, signal)
      : await fetchAnthropicCompatibleModels(baseUrl, apiKey, proxyUrl, provider, signal)
    return { success: result.success, message: result.success ? '模型目录可达（未验证模型生成）' : result.message }
  }
  const fetchFn = getFetchFn(proxyUrl)

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (provider === 'ollama') {
    headers.Authorization = `Bearer ${apiKey || 'ollama'}`
  } else if (provider === 'kimi-coding' || provider === 'zhipu-coding' || provider === 'zhipu-coding-team') {
    const token = provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
    headers.Authorization = `Bearer ${token}`
    headers['User-Agent'] = getProferUserAgent(pkg.version)
  } else if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getProferUserAgent(pkg.version)
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const endpoint = resolveAnthropicMessagesUrl(baseUrl, provider)
  const response = await fetchFn(endpoint, withTimeout({
    signal,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }))

  if (response.ok) {
    assertGenerationResponse(await response.json(), 'anthropic')
    return { success: true, message: `模型 ${modelId} 生成测试成功` }
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
async function testOpenAICompatible(baseUrl: string, apiKey: string, proxyUrl?: string, modelId?: string, provider: ProviderType = 'openai', signal?: AbortSignal): Promise<ChannelTestResult> {
  if (!modelId?.trim()) {
    const result = await fetchOpenAICompatibleModels(baseUrl, apiKey, proxyUrl, signal)
    return { success: result.success, message: result.success ? '模型目录可达（未验证模型生成）' : result.message }
  }
  const responsesApi = provider === 'openai-responses' || provider === 'xai'
  const url = responsesApi ? resolveOpenAIResponsesUrl(baseUrl) : resolveOpenAIChatCompletionsUrl(baseUrl, provider)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(url, withTimeout({
    signal,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(responsesApi
      ? { model: modelId, input: 'hi', max_output_tokens: 16 }
      : { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  }))

  if (response.ok) {
    assertGenerationResponse(await response.json(), responsesApi ? 'responses' : 'openai')
    return { success: true, message: `模型 ${modelId} 生成测试成功` }
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
async function testGoogle(baseUrl: string, apiKey: string, proxyUrl?: string, modelId?: string, signal?: AbortSignal): Promise<ChannelTestResult> {
  if (!modelId?.trim()) {
    const result = await fetchGoogleModels(baseUrl, apiKey, proxyUrl, signal)
    return { success: result.success, message: result.success ? '模型目录可达（未验证模型生成）' : result.message }
  }
  const url = new URL(resolveGoogleModelsUrl(baseUrl, apiKey))
  url.pathname += `/${encodeURIComponent(modelId.replace(/^models\//, ''))}:generateContent`
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(url.toString(), withTimeout({
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
  }))

  if (response.ok) {
    assertGenerationResponse(await response.json(), 'google')
    return { success: true, message: `模型 ${modelId} 生成测试成功` }
  }

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

// ===== 订阅 Plan 额度查询 =====

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizePlanQuotaTimestamp(value?: number | string): number | undefined {
  if (value == null || value === '') return undefined
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return undefined
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
}

function planQuotaResetAt(value?: number | string): Pick<import('@profer/shared').ChannelPlanQuotaWindow, 'resetAt'> {
  const resetAt = normalizePlanQuotaTimestamp(value)
  return resetAt ? { resetAt } : {}
}

function createUnsupportedPlanQuota(provider: ProviderType, message: string): import('@profer/shared').ChannelPlanQuotaResult {
  return {
    supported: false,
    provider,
    windows: [],
    updatedAt: Date.now(),
    message,
  }
}

async function queryKimiPlanQuota(apiKey: string, proxyUrl?: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> {
  const fetchFn = getFetchFn(proxyUrl)
  const response = await fetchFn('https://api.kimi.com/coding/v1/usages', withPlanQuotaTimeout({
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getProferUserAgent(pkg.version),
      Authorization: `Bearer ${apiKey}`,
    },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return createUnsupportedPlanQuota('kimi-coding', `Kimi 额度查询失败: HTTP ${response.status}`)
  }

  let data: {
    usage?: { remaining?: string | number; used?: string | number; resetTime?: string }
    limits?: Array<{
      window: { duration: number; timeUnit: string }
      detail: { remaining?: string | number; used?: string | number; resetTime?: string }
    }>
    code?: string
  }
  try {
    data = JSON.parse(responseText)
  } catch {
    return createUnsupportedPlanQuota('kimi-coding', 'Kimi 额度响应格式错误')
  }

  if (data.code) {
    return createUnsupportedPlanQuota('kimi-coding', `Kimi 额度查询失败: ${data.code}`)
  }
  if (!data.usage) {
    return createUnsupportedPlanQuota('kimi-coding', 'Kimi 未返回订阅额度数据')
  }

  const windows: import('@profer/shared').ChannelPlanQuotaWindow[] = []
  const summaryRemaining = clampPercent(Number(data.usage.remaining ?? 0))
  const summaryUsed = clampPercent(Number(data.usage.used ?? (100 - summaryRemaining)))
  windows.push({
    type: 'weekly',
    label: '每周额度',
    remainingPercent: summaryRemaining,
    usedPercent: summaryUsed,
    ...planQuotaResetAt(data.usage.resetTime),
  })

  for (const item of data.limits ?? []) {
    const remaining = clampPercent(Number(item.detail.remaining ?? 0))
    const used = clampPercent(Number(item.detail.used ?? (100 - remaining)))
    const duration = item.window.duration
    const isFiveHourWindow = (duration === 5 && item.window.timeUnit === 'TIME_UNIT_HOUR')
      || (duration === 300 && item.window.timeUnit === 'TIME_UNIT_MINUTE')
    const unitLabel = item.window.timeUnit === 'TIME_UNIT_HOUR'
      ? '小时'
      : item.window.timeUnit === 'TIME_UNIT_MINUTE'
        ? '分钟'
        : item.window.timeUnit === 'TIME_UNIT_DAY'
          ? '天'
          : item.window.timeUnit === 'TIME_UNIT_MONTH'
            ? '月'
            : item.window.timeUnit
    windows.push({
      type: isFiveHourWindow ? '5h' : 'custom',
      label: isFiveHourWindow ? '每 5 小时' : `${duration} ${unitLabel}`,
      remainingPercent: remaining,
      usedPercent: used,
      ...planQuotaResetAt(item.detail.resetTime),
    })
  }

  return {
    supported: true,
    provider: 'kimi-coding',
    planName: 'Kimi For Coding',
    windows,
    updatedAt: Date.now(),
  }
}

async function queryMiniMaxPlanQuota(apiKey: string, baseUrl: string, proxyUrl?: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> {
  const fetchFn = getFetchFn(proxyUrl)
  let requestUrl = 'https://www.minimaxi.com/v1/token_plan/remains'
  try {
    if (new URL(baseUrl).hostname.includes('minimax.io')) {
      requestUrl = requestUrl.replace('.minimaxi.com', '.minimax.io')
    }
  } catch {
    // 保持默认查询地址
  }

  const response = await fetchFn(requestUrl, withPlanQuotaTimeout({
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': getProferUserAgent(pkg.version),
    },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return createUnsupportedPlanQuota('minimax', `MiniMax Token Plan 额度查询失败: HTTP ${response.status}`)
  }

  let data: {
    model_remains?: Array<{
      model_name: string
      current_interval_remaining_percent?: number
      current_weekly_total_count?: number
      current_weekly_remaining_percent?: number
      end_time?: number
      weekly_end_time?: number
    }>
    base_resp?: { status_code: number; status_msg: string }
  }
  try {
    data = JSON.parse(responseText)
  } catch {
    return createUnsupportedPlanQuota('minimax', 'MiniMax Token Plan 额度响应格式错误')
  }

  if (data.base_resp && data.base_resp.status_code !== 0) {
    return createUnsupportedPlanQuota('minimax', data.base_resp.status_msg || 'MiniMax Token Plan 额度查询失败')
  }

  const general = (data.model_remains ?? []).filter((item) => item.model_name === 'general')
  if (general.length === 0) {
    return createUnsupportedPlanQuota('minimax', 'MiniMax Token Plan 未返回通用额度数据')
  }

  // `current_weekly_total_count=0` 仍代表 API 返回了有效周额度窗口，不能用 truthiness 跳过。
  const windows = parseMiniMaxGeneralQuotaWindows(general)

  return {
    supported: true,
    provider: 'minimax',
    planName: 'MiniMax Token Plan',
    windows,
    updatedAt: Date.now(),
  }
}

function formatDeepSeekBalanceAmount(currency: string | undefined, value: string | number | undefined): string {
  const raw = value == null ? 0 : Number(value)
  const amount = Number.isFinite(raw) ? raw : 0
  const normalizedCurrency = (currency ?? '').trim().toUpperCase()
  if (normalizedCurrency === 'CNY' || normalizedCurrency === 'RMB') {
    return `¥${amount.toFixed(2)}`
  }
  if (normalizedCurrency === 'USD') {
    return `$${amount.toFixed(2)}`
  }
  if (normalizedCurrency) {
    return `${normalizedCurrency} ${amount.toFixed(2)}`
  }
  return amount.toFixed(2)
}

async function queryDeepSeekBalance(apiKey: string, baseUrl: string, proxyUrl?: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> {
  const fetchFn = getFetchFn(proxyUrl)
  let requestUrl = 'https://api.deepseek.com/user/balance'
  try {
    requestUrl = `${new URL(baseUrl).origin}/user/balance`
  } catch {
    // 保持官方默认查询地址
  }

  const response = await fetchFn(requestUrl, withPlanQuotaTimeout({
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': getProferUserAgent(pkg.version),
    },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return createUnsupportedPlanQuota('deepseek', `DeepSeek 余额查询失败: HTTP ${response.status}`)
  }

  let data: {
    is_available?: boolean
    balance_infos?: Array<{
      currency?: string
      total_balance?: string
      granted_balance?: string
      topped_up_balance?: string
    }>
    error?: { message?: string }
  }
  try {
    data = JSON.parse(responseText)
  } catch {
    return createUnsupportedPlanQuota('deepseek', 'DeepSeek 余额响应格式错误')
  }

  if (data.error?.message) {
    return createUnsupportedPlanQuota('deepseek', data.error.message)
  }

  const balances = data.balance_infos ?? []
  if (balances.length === 0) {
    return createUnsupportedPlanQuota('deepseek', 'DeepSeek 未返回余额数据')
  }

  const preferred = balances.find((item) => (item.currency ?? '').toUpperCase() === 'CNY')
    ?? balances.find((item) => Number(item.total_balance ?? 0) > 0)
    ?? balances[0]!
  const amountLabel = formatDeepSeekBalanceAmount(preferred.currency, preferred.total_balance)
  const granted = Number(preferred.granted_balance ?? 0)
  const toppedUp = Number(preferred.topped_up_balance ?? 0)
  const total = Number(preferred.total_balance ?? 0)
  const denominator = granted + toppedUp
  const remainingPercent = denominator > 0
    ? clampPercent((total / denominator) * 100)
    : data.is_available === false
      ? 0
      : 100

  return {
    supported: true,
    provider: 'deepseek',
    planName: 'DeepSeek 账户余额',
    windows: [{
      type: 'custom',
      label: '账户余额',
      remainingPercent,
      usedPercent: clampPercent(100 - remainingPercent),
      remainingLabel: amountLabel,
      showProgress: denominator > 0,
    }],
    updatedAt: Date.now(),
    message: data.is_available === false ? 'DeepSeek 账户余额不可用' : undefined,
  }
}

// ===== 智谱 Coding Plan 额度查询 =====

interface ZhipuQuotaLimitItem {
  type: 'TIME_LIMIT' | 'TOKENS_LIMIT'
  unit?: number
  number?: number
  percentage?: number
  remaining?: number
  usage?: number
  currentValue?: number
  nextResetTime?: number
  usageDetails?: Array<{
    modelCode: string
    usage: number
  }>
}

interface ZhipuQuotaResponse {
  code?: number
  msg?: string
  success?: boolean
  data?: {
    limits?: ZhipuQuotaLimitItem[]
    level?: string
  }
}

function createZhipuQuotaUrl(baseUrl: string, query?: Record<string, string>): string {
  let requestUrl = 'https://bigmodel.cn/api/monitor/usage/quota/limit'
  try {
    const hostname = new URL(baseUrl).hostname
    if (hostname === 'api.z.ai') {
      requestUrl = 'https://api.z.ai/api/monitor/usage/quota/limit'
    } else if (hostname === 'open.bigmodel.cn') {
      requestUrl = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
    }
  } catch {
    // 保持默认查询地址
  }

  const url = new URL(requestUrl)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function createZhipuInternationalQuotaUrl(query?: Record<string, string>): string {
  const url = new URL('https://api.z.ai/api/monitor/usage/quota/limit')
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

async function fetchZhipuQuota(
  apiKey: string,
  requestUrl: string,
  proxyUrl?: string,
): Promise<ZhipuQuotaResponse | { error: string }> {
  const fetchFn = getFetchFn(proxyUrl)
  const response = await fetchFn(requestUrl, withPlanQuotaTimeout({
    method: 'GET',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      'User-Agent': getProferUserAgent(pkg.version),
    },
  }))
  const responseText = await response.text()
  if (!response.ok) {
    return { error: `智谱 Coding Plan 额度查询失败: HTTP ${response.status}` }
  }

  try {
    return JSON.parse(responseText) as ZhipuQuotaResponse
  } catch {
    return { error: '智谱 Coding Plan 额度响应格式错误' }
  }
}

function parseZhipuQuotaData(
  data: ZhipuQuotaResponse,
  planName: string,
  provider: ProviderType = 'zhipu-coding',
): import('@profer/shared').ChannelPlanQuotaResult {
  if (!data.success || data.code !== 200) {
    return createUnsupportedPlanQuota(provider, data.msg || '智谱 Coding Plan 额度查询失败')
  }

  const limits = data.data?.limits ?? []
  const windows: import('@profer/shared').ChannelPlanQuotaWindow[] = []
  const tokenLimits = limits
    .filter((item) => item.type === 'TOKENS_LIMIT')
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftReset = normalizePlanQuotaTimestamp(left.item.nextResetTime)
      const rightReset = normalizePlanQuotaTimestamp(right.item.nextResetTime)
      if (leftReset && rightReset && leftReset !== rightReset) {
        return leftReset - rightReset
      }
      return left.index - right.index
    })

  for (const { item, index } of tokenLimits) {
    const used = clampPercent(item.percentage ?? 0)
    const type = item.unit === 3
      ? '5h'
      : item.unit === 6
        ? 'weekly'
        : item.unit == null && index === 0
          ? '5h'
          : item.unit == null && index === 1
            ? 'weekly'
            : undefined
    if (!type) continue
    windows.push({
      type,
      label: type === '5h' ? '每 5 小时' : '每周额度',
      remainingPercent: clampPercent(100 - used),
      usedPercent: used,
      ...planQuotaResetAt(item.nextResetTime),
    })
  }

  const timeLimit = limits.find((item) => item.type === 'TIME_LIMIT')
  if (timeLimit) {
    const remainingCount = Number(timeLimit.remaining ?? 0)
    const totalCount = Number(timeLimit.usage ?? 0)
    const usedCount = Number(timeLimit.currentValue ?? (totalCount > 0 ? totalCount - remainingCount : 0))
    const total = totalCount > 0 ? totalCount : remainingCount + usedCount
    const remainingPercent = total > 0 ? (remainingCount / total) * 100 : 0
    windows.push({
      type: 'custom',
      label: 'MCP 每月',
      remainingPercent: clampPercent(remainingPercent),
      usedPercent: clampPercent(100 - remainingPercent),
    })
  }

  if (windows.length === 0) {
    return createUnsupportedPlanQuota(provider, '智谱 Coding Plan 未返回窗口额度数据')
  }

  return {
    supported: true,
    provider,
    planName,
    windows,
    updatedAt: Date.now(),
  }
}

async function queryZhipuPlanQuota(
  apiKey: string,
  baseUrl: string,
  proxyUrl?: string,
  provider: ProviderType = 'zhipu-coding',
): Promise<import('@profer/shared').ChannelPlanQuotaResult> {
  const requestUrls = Array.from(new Set([
    createZhipuQuotaUrl(baseUrl),
    createZhipuQuotaUrl(baseUrl, { type: '1' }),
    createZhipuInternationalQuotaUrl(),
    createZhipuInternationalQuotaUrl({ type: '1' }),
  ]))

  // 并行发起多个候选 URL，任一成功即短路返回；避免之前串行逐个 await、网络慢时逐个卡 5s 超时。
  const results = await Promise.all(
    requestUrls.map((requestUrl) => fetchZhipuQuota(apiKey, requestUrl, proxyUrl)),
  )

  const supportedResult = results
    .map((response) => ('error' in response ? null : parseZhipuQuotaData(response, 'GLM Coding Plan', provider)))
    .find((result) => result?.supported && result.windows.length > 0)
  if (supportedResult) return supportedResult

  // 无成功结果时，回退到最后一条可用的错误信息（优先带 error 的，其次第一个解析结果）
  const firstError = results.find((r) => 'error' in r)
  if (firstError && 'error' in firstError) {
    return createUnsupportedPlanQuota(provider, firstError.error)
  }
  const firstParsed = results
    .map((response) => ('error' in response ? null : parseZhipuQuotaData(response, 'GLM Coding Plan', provider)))
    .find((result) => result != null)
  return firstParsed ?? createUnsupportedPlanQuota(provider, '智谱 Coding Plan 未返回窗口额度数据')
}

export async function getChannelPlanQuota(channelId: string): Promise<import('@profer/shared').ChannelPlanQuotaResult> {
  const channel = getChannelById(channelId)
  if (!channel) {
    return createUnsupportedPlanQuota('custom', '渠道不存在')
  }

  const provider = channel.provider
  if (channel.serverManaged) {
    return createUnsupportedPlanQuota(provider, 'Profer 代管渠道不支持查询第三方订阅额度')
  }

  const supportsPlanQuota = provider === 'openai-codex' || supportsProviderPlanQuota(provider) || channel.baseUrl.includes('api.kimi.com/coding')
  if (!supportsPlanQuota) {
    return createUnsupportedPlanQuota(provider, '当前渠道不支持订阅 Plan 额度查询')
  }

  let apiKey: string
  let channelUpdatedAt = channel.updatedAt
  try {
    apiKey = provider === 'openai-codex'
      ? (await resolveCodexOAuthCredentials(channelId)).access
      : decryptKey(channel.apiKey)
    if (provider === 'openai-codex') channelUpdatedAt = getChannelById(channelId)?.updatedAt ?? channelUpdatedAt
  } catch {
    return createUnsupportedPlanQuota(provider, '无法读取渠道 API Key')
  }

  // 统一注入渠道 updatedAt，renderer 侧据此区分「渠道是否为当前版本」并命中缓存。
  const withChannelVersion = (
    result: import('@profer/shared').ChannelPlanQuotaResult,
  ): import('@profer/shared').ChannelPlanQuotaResult => ({ ...result, channelUpdatedAt })

  try {
    const proxyUrl = await getEffectiveProxyUrl()
    if (provider === 'openai-codex') {
      const response = await getFetchFn(proxyUrl)('https://chatgpt.com/backend-api/wham/usage', withPlanQuotaTimeout({
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'User-Agent': getProferUserAgent(pkg.version),
        },
      }))
      if (!response.ok) {
        return createUnsupportedPlanQuota(provider, `ChatGPT Codex 额度查询失败: HTTP ${response.status}`)
      }
      return withChannelVersion(parseCodexPlanQuotaResponse(await response.json()))
    }
    if (provider === 'deepseek') {
      return withChannelVersion(await queryDeepSeekBalance(apiKey, channel.baseUrl, proxyUrl))
    }
    if (provider === 'kimi-coding' || channel.baseUrl.includes('api.kimi.com/coding')) {
      return withChannelVersion(await queryKimiPlanQuota(apiKey, proxyUrl))
    }
    if (provider === 'minimax') {
      return withChannelVersion(await queryMiniMaxPlanQuota(apiKey, channel.baseUrl, proxyUrl))
    }
    if (provider === 'zhipu-coding') {
      return withChannelVersion(await queryZhipuPlanQuota(apiKey, channel.baseUrl, proxyUrl, provider))
    }

    return withChannelVersion(createUnsupportedPlanQuota(provider, '当前渠道不支持订阅 Plan 额度查询'))
  } catch (error) {
    const message = error instanceof Error ? error.message : '订阅额度查询失败'
    return withChannelVersion(createUnsupportedPlanQuota(provider, message))
  }
}

// ===== 直接测试连接 =====

/**
 * 直接测试连接（无需已保存渠道）
 *
 * 使用传入的明文凭证直接向提供商发送测试请求。
 * 适用于创建/编辑渠道时用户在保存前先验证连接。
 */
export async function testChannelDirect(input: FetchModelsInput, signal?: AbortSignal): Promise<ChannelTestResult> {
  try {
    signal?.throwIfAborted()
    // Agent 测试不能把直接 fetch 成功误报为 SDK 路由可用。
    // 测试地址必须与运行时实际消费的派生地址一致（resolveRuntimeBaseUrl 的分派）：
    // Claude 用 inferAgentBaseUrl；Pi 对 Anthropic 协议渠道也吃 agentBaseUrl，
    // 不能只用 input.baseUrl——否则「测试通过 ≠ Agent 可用」。
    if (input.runtime) {
      const runtimeUrl = input.runtime === 'claude'
        ? inferAgentBaseUrl(input.provider, input.baseUrl, input.agentBaseUrl)
        : resolveProviderNativeProtocol(input.provider, input.baseUrl) === 'anthropic-messages'
          ? inferAgentBaseUrl(input.provider, input.baseUrl, input.agentBaseUrl)
          : input.baseUrl
      try {
        if (runtimeUrl) assertSdkBaseUrlSupportsRouting(runtimeUrl)
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Agent SDK 端点无效' }
      }
    }
    const proxyUrl = await getEffectiveProxyUrl()
    signal?.throwIfAborted()
    if (input.modelId !== undefined && !input.modelId.trim()) {
      return { success: false, message: '测试模型 ID 不能为空' }
    }
    if (input.runtime === 'claude') {
      if (input.provider === 'xai' || input.provider === 'openai-codex') {
        return { success: false, message: '此供应商不支持 Claude 内核测试' }
      }
      const agentUrl = inferAgentBaseUrl(input.provider, input.baseUrl, input.agentBaseUrl)
      if (!agentUrl) return { success: false, message: '未配置 Claude 端点' }
      const provider = ['custom', 'openai', 'openai-responses', 'google', 'zhipu', 'doubao', 'qwen', 'opencode-go-openai'].includes(input.provider)
        ? 'anthropic' : input.provider
      const result = await testAnthropicCompatible(agentUrl, input.apiKey, proxyUrl, provider, input.modelId, signal)
      return { ...result, message: `Claude 端点：${result.message}` }
    }
    if (input.provider === 'deepseek' && isAnthropicShapedEndpoint(input.baseUrl)) {
      return await testAnthropicCompatible(input.baseUrl, input.apiKey, proxyUrl, input.provider, input.modelId, signal)
    }
    // ollama 无独立测试实现，沿用 Anthropic 兼容测试（与原 switch 一致）。
    const directAdapterKind = input.provider === 'ollama' ? 'anthropic' : resolveChatAdapterKind(input.provider)
    switch (directAdapterKind) {
      case 'anthropic':
        return await testAnthropicCompatible(input.baseUrl, input.apiKey, proxyUrl, input.provider, input.modelId, signal)
      case 'openai':
        return await testOpenAICompatible(input.baseUrl, input.apiKey, proxyUrl, input.modelId, input.provider, signal)
      case 'google':
        return await testGoogle(input.baseUrl, input.apiKey, proxyUrl, input.modelId, signal)
      default:
        return { success: false, message: `不支持的提供商: ${input.provider}` }
    }
  } catch (error) {
    if (signal?.aborted) return { success: false, cancelled: true, message: '请求已取消' }
    return { success: false, message: error instanceof Error && error.name === 'TimeoutError' ? '连接测试超时（15 秒），请重试' : '连接测试失败，请检查端点、凭据或供应商响应' }
  }
}

// ===== 模型拉取相关 =====

/**
 * 从供应商 API 拉取可用模型列表
 *
 * 直接使用传入的凭证（无需已保存渠道），支持创建渠道时预先拉取模型。
 * 针对不同供应商使用不同的 API 端点和响应解析。
 */
export async function fetchModels(input: FetchModelsInput, signal?: AbortSignal): Promise<FetchModelsResult> {
  try {
    signal?.throwIfAborted()
    const proxyUrl = await getEffectiveProxyUrl()
    signal?.throwIfAborted()
    switch (resolveChatAdapterKind(input.provider)) {
      case 'anthropic':
        return await fetchAnthropicCompatibleModels(input.baseUrl, input.apiKey, proxyUrl, input.provider, signal)
      case 'ollama':
        return await fetchOllamaModels(input.baseUrl, input.apiKey, proxyUrl, signal)
      case 'openai':
        return await fetchOpenAICompatibleModels(input.baseUrl, input.apiKey, proxyUrl, signal)
      case 'google':
        return await fetchGoogleModels(input.baseUrl, input.apiKey, proxyUrl, signal)
      case 'unsupported':
        return { success: false, message: `不支持的供应商: ${input.provider}`, models: [] }
    }
  } catch (error) {
    if (signal?.aborted) return { success: false, cancelled: true, message: '请求已取消', models: [] }
    return { success: false, message: error instanceof Error && error.name === 'TimeoutError' ? '拉取模型超时（15 秒），请重试' : '拉取模型失败，请检查端点、凭据或供应商响应', models: [] }
  }
}

/** 响应必须是成功对象，不能把 HTTP 200 错误包当权威空目录。 */
function assertApiObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.error !== undefined || value.type === 'error' || value.success === false
    || (value.code !== undefined && value.code !== 0 && value.code !== 200 && value.code !== '0' && value.code !== '200')) {
    throw new Error('供应商响应结构无效或返回错误')
  }
}

function assertGenerationResponse(value: unknown, protocol: 'anthropic' | 'openai' | 'responses' | 'google'): void {
  assertApiObject(value)
  const field = protocol === 'anthropic' ? 'content' : protocol === 'openai' ? 'choices' : protocol === 'responses' ? 'output' : 'candidates'
  const output = value[field]
  if (!Array.isArray(output) || output.length === 0 || output.some((item) => !isRecord(item))) throw new Error('模型生成响应结构无效')
}

function modelString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`模型目录 ${field} 无效`)
  return value
}

function modelPage(value: unknown, field: 'data' | 'models'): { data: Record<string, unknown>; items: Record<string, unknown>[] } {
  assertApiObject(value)
  if ((value.object !== undefined && value.object !== 'list') || !Array.isArray(value[field])) throw new Error('模型目录响应结构无效')
  const items: Record<string, unknown>[] = []
  for (const item of value[field]) {
    if (!isRecord(item)) throw new Error('模型目录包含无效条目')
    items.push(item)
  }
  return { data: value, items }
}

function fetchedModel(id: string, name: string = id): ChannelModel {
  return { id, name, enabled: true, source: 'fetched' }
}

function modelsResult(models: ChannelModel[], sort = false): FetchModelsResult {
  const byId = new Map<string, ChannelModel>()
  for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model)
  const unique = [...byId.values()]
  if (sort) unique.sort((a, b) => a.id.localeCompare(b.id))
  return { success: true, message: `成功获取 ${unique.length} 个模型`, models: unique }
}

/** Google / Ollama 原生端点只操作 pathname，保留既有 query 路由。 */
function resolveGoogleModelsUrl(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl.trim())
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/models') ? path : `${path.replace(/\/v1beta$/, '')}/v1beta/models`
  url.searchParams.set('key', apiKey)
  return url.toString()
}

function resolveOllamaTagsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api\/tags$/, '')}/api/tags`
  return url.toString()
}

/** 从 Ollama 原生 API 读取本机已安装模型；此操作不会触发下载。 */
async function fetchOllamaModels(baseUrl: string, apiKey: string, proxyUrl?: string, signal?: AbortSignal): Promise<FetchModelsResult> {
  const fetchFn = getFetchFn(proxyUrl)
  const response = await fetchFn(resolveOllamaTagsUrl(baseUrl), withTimeout({
    signal,
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey || 'ollama'}` },
  }))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const hint = response.status === 404 ? '；请确认 Ollama 服务已启动' : ''
    return { success: false, message: `Ollama 请求失败 (${response.status})${hint}${text ? `: ${text.slice(0, 200)}` : ''}`, models: [] }
  }
  const { items } = modelPage(await response.json(), 'models')
  return modelsResult(items.map((item) => fetchedModel(modelString(item.name, 'name'))), true)
}

async function fetchAnthropicCompatibleModels(
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  provider: ProviderType = 'anthropic',
  signal?: AbortSignal,
): Promise<FetchModelsResult> {
  const url = new URL(resolveAnthropicModelsUrl(baseUrl, provider))
  const fetchFn = getFetchFn(proxyUrl)

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (provider === 'kimi-coding' || provider === 'zhipu-coding' || provider === 'zhipu-coding-team') {
    const token = provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
    headers.Authorization = `Bearer ${token}`
    headers['User-Agent'] = getProferUserAgent(pkg.version)
  } else if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
    headers['User-Agent'] = getProferUserAgent(pkg.version)
  } else if (provider === 'minimax') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  // 整次分页共用 15s signal；失败时不返回部分目录，以免 renderer 删除未取完的模型。
  const init = withTimeout({ method: 'GET', headers, signal })
  const models: ChannelModel[] = []
  const cursors = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const response = await fetchFn(url.toString(), init)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { success: false, message: response.status === 401 ? 'API Key 无效' : `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
    }
    const { data, items } = modelPage(await response.json(), 'data')
    for (const item of items) {
      if (item.type !== undefined && item.type !== 'model') throw new Error('模型目录条目 type 无效')
      const id = modelString(item.id, 'id')
      models.push(fetchedModel(id, item.display_name === undefined ? id : modelString(item.display_name, 'display_name')))
    }
    if (data.has_more !== undefined && typeof data.has_more !== 'boolean') throw new Error('模型目录分页结构无效')
    if (data.has_more !== true) return modelsResult(models)
    const cursor = modelString(data.last_id, 'last_id')
    if (items.length === 0 || cursors.has(cursor) || !items.some((item) => item.id === cursor)) throw new Error('模型目录分页未前进')
    cursors.add(cursor)
    url.searchParams.set('after_id', cursor)
  }
  throw new Error('模型目录分页超出上限')
}

/**
 * 从 OpenAI 兼容 API 拉取模型列表（OpenAI / Custom）
 *
 * API: GET {baseUrl}/models
 * 通用 OpenAI 兼容格式，适用于大部分第三方供应商。
 */
async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, proxyUrl?: string, signal?: AbortSignal): Promise<FetchModelsResult> {
  const url = resolveOpenAIModelsUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(url, withTimeout({
    signal,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }))

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const { data, items } = modelPage(await response.json(), 'data')
  // 标准 OpenAI /models 无分页；未知兼容分页协议不可把首页冒充完整清单。
  if ((data.has_more !== undefined && data.has_more !== false) || data.nextPageToken || data.next) throw new Error('此 OpenAI 模型目录分页协议不受支持')
  return modelsResult(items.map((item) => {
    if (item.object !== undefined && item.object !== 'model') throw new Error('模型目录条目 object 无效')
    const id = modelString(item.id, 'id')
    if (item.name !== undefined) modelString(item.name, 'name')
    return fetchedModel(id)
  }), true)
}

/**
 * 从 Google Generative AI API 拉取模型列表
 *
 * API: GET /v1beta/models?key={apiKey}
 * 仅返回支持 generateContent 的模型（排除纯 embedding 模型）。
 */
async function fetchGoogleModels(baseUrl: string, apiKey: string, proxyUrl?: string, signal?: AbortSignal): Promise<FetchModelsResult> {
  const url = new URL(resolveGoogleModelsUrl(baseUrl, apiKey))
  const fetchFn = getFetchFn(proxyUrl)
  const init = withTimeout({ method: 'GET', signal })
  const models: ChannelModel[] = []
  const tokens = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const response = await fetchFn(url.toString(), init)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { success: false, message: response.status === 400 || response.status === 403 ? 'API Key 无效' : `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
    }
    const { data, items } = modelPage(await response.json(), 'models')
    for (const item of items) {
      const name = modelString(item.name, 'name')
      if (!name.startsWith('models/') || !name.slice(7).trim()) throw new Error('Google 模型 name 无效')
      const id = name.slice(7)
      const displayName = item.displayName === undefined ? id : modelString(item.displayName, 'displayName')
      if (!Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.some((method) => typeof method !== 'string')) throw new Error('Google 模型生成能力结构无效')
      if (item.supportedGenerationMethods.includes('generateContent')) models.push(fetchedModel(id, displayName))
    }
    if (data.nextPageToken === undefined || data.nextPageToken === '') return modelsResult(models)
    const token = modelString(data.nextPageToken, 'nextPageToken')
    if (tokens.has(token)) throw new Error('模型目录分页未前进')
    tokens.add(token)
    url.searchParams.set('pageToken', token)
  }
  throw new Error('模型目录分页超出上限')
}
