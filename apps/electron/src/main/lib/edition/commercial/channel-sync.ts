/**
 * 商业版渠道管理：服务端下发渠道的同步、登出清理与旧备份恢复。
 *
 * 这三件事只在有「服务端管理渠道」的发行版里成立，因此从 channel-manager 移到这里，
 * 由 `edition/commercial.ts` 装配成 `channels.syncFromServer / pruneManagedOnLogout /
 * restoreForAccount`。开源版没有这三个方法，OSS 产物里也不会再出现它们的实现。
 *
 * channel-manager 通过 `EditionChannelStore` 注入底层能力（读写 channels.json、加密、
 * 会话快照、目录失效通知），本模块因此不 import channel-manager，避免
 * `channel-manager → edition → commercial → channel-manager` 的循环依赖。
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import type { ChannelsConfig, ChannelModel, ProviderType } from '@profer/shared'
import { isChannelEnabledForAnyRuntime } from '@profer/shared'
import type { EditionChannelStore } from '@profer/edition-contract'
import { decryptToken } from '../../token-crypto'
import { getFetchFn } from '../../proxy-fetch'
import { mergeServerChannelModels, normalizeChannelForCurrentSchema } from '../../channel-url-routing'

/** 登出清理官方代管渠道的结果 */
export interface PruneChannelsResult {
  /** 被移除的官方渠道数量（0 = 无需清理或清理失败） */
  removed: number
  /** 非空时表示清理失败，原配置保持不变 */
  error?: string
}
/**
 * 登出时清理官方代管渠道，保留用户自配渠道
 *
 * 渠道归属规则：
 *  - 用户自配渠道是用户本地资产：登出后**原样保留**，不加密备份、不清空。
 *    （旧版本会在登出时把自配渠道加密备份后清空 channels.json，
 *    导致「账号一下线，全部自配 API 就消失」，该限制已取消。）
 *  - 官方代管渠道的凭据（relay token 等）随账号会话由服务端下发，登出后不应继续留在本地；
 *    下次登录会由 syncChannelsFromServer 重新同步。
 *
 * 失败时保持原配置不动：宁可暂时留下官方渠道，也不破坏用户的自配配置。
 */
export function pruneManagedOnLogout(store: EditionChannelStore): PruneChannelsResult {
  let current: ChannelsConfig
  try {
    current = store.readConfig()
  } catch (err) {
    return { removed: 0, error: `读取渠道配置失败: ${(err as Error).message}` }
  }

  const keptChannels = current.channels.filter((channel) => !store.isManagedChannel(channel))
  const removed = current.channels.length - keptChannels.length
  if (removed === 0) return { removed: 0 }

  try {
    store.writeConfig({ ...current, channels: keptChannels })
  } catch (err) {
    return { removed: 0, error: `写入渠道配置失败: ${(err as Error).message}` }
  }

  console.log(`[渠道管理] 登出已移除 ${removed} 个官方渠道，保留 ${keptChannels.length} 个自配渠道`)

  // 通知渲染进程刷新渠道目录；通知失败不影响登出结果。
  try {
    store.invalidateCatalog()
  } catch { /* 目录通知失败忽略 */ }

  return { removed }
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
 * 仅用于兼容**旧版本**登出时留下的加密备份（新版本登出不再清空自配渠道，因此不再产生备份）。
 * login 成功后调用：把备份中的自配渠道合并进当前配置（同 ID 不覆盖），
 * 恢复成功且落盘后才删除备份文件。
 * 任何失败（解密/解析/落盘）都**保留备份文件**，不静默丢弃，便于用户二次抢救。
 */
export function restoreForAccount(store: EditionChannelStore, accountId: string): RestoreChannelsResult {
  const backupPath = store.logoutBackupPath(accountId)
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
    store.validateConfig(parsed)
  } catch (err) {
    return { restored: 0, error: `渠道备份解析失败（已保留备份文件供抢救）: ${(err as Error).message}`, backupRetained: true }
  }

  const backedUpChannels = (parsed.channels || []).filter((channel) => !store.isManagedChannel(channel))
  if (backedUpChannels.length === 0) {
    // 兼容旧版“整份配置备份”：解密确认有效后清理仅含官方渠道的旧备份。
    rmSync(backupPath, { force: true })
    return { restored: 0, backupRetained: false }
  }

  // 合并而不是要求当前配置完全为空：登录其他账号后，官方渠道可能已先同步到本地，
  // 不能因此阻断原账号自配渠道的恢复。已有同 ID 渠道不覆盖。
  let current: ChannelsConfig
  try {
    current = store.readConfig()
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
    store.writeConfig({ ...current, channels: [...current.channels, ...channelsToRestore] })
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
export async function syncFromServer(store: EditionChannelStore, serverBaseUrl: string, accessToken: string): Promise<boolean> {
  // 记录请求发起时的账号身份。登出后旧请求即使返回成功，也不得把官方渠道写回本地。
  // 账号能力经发行版契约获取：开源版恒为 null，这条路径在那里会直接抛错退出。
  const generationAtStart = store.getSessionGeneration()
  const authAtStart = store.getSessionSnapshot()
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
  const authBeforeWrite = store.getSessionSnapshot()
  if (!authBeforeWrite || authBeforeWrite.baseUrl !== serverBaseUrl || authBeforeWrite.teamAccountId !== accountIdAtStart
    || authBeforeWrite.token !== authAtStart.token
    || generationAtStart !== store.getSessionGeneration()) {
    throw new Error('渠道同步已跳过：请求完成时团队会话已变化')
  }

  // 防止空列表雪崩：服务端返回 0 条渠道时跳过同步，保留现有本地缓存。
  // 空结果通常是服务端异常导致，不应将客户端全部渠道清空。
  if (data.channels.length === 0) {
    console.warn('[渠道管理] 服务端返回空渠道列表，跳过同步以保留现有渠道')
    return false
  }

  const existingConfig = store.readConfig()
  // 备份旧配置
  const configPath = store.channelsPath()
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
    if (store.isManagedChannel(c)) return false // 之前由服务端管理但现在不在列表中了 → 已删除，清理
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
      apiKey: store.encryptKey(ch.apiKey),
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

  store.writeConfig(config)
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
        const agentCapableChannels = config.channels.filter((c) => isChannelEnabledForAnyRuntime(c))
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
  store.invalidateCatalog()
  return true
}
