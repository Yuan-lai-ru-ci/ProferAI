/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.profer/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { normalizeGoalProposalPolicy } from './goal-proposal-service'
import { DEFAULT_AGENT_RUNTIME, DEFAULT_HANDOFF_SUGGEST_TURN_COUNT, MAX_HANDOFF_SUGGEST_TURN_COUNT, DEFAULT_INTERFACE_VARIANT, DEFAULT_PREVIEW_OPEN_MODE, DEFAULT_THEME_MODE, DEFAULT_USER_MESSAGE_POSITION } from '../../types'
import { normalizeAgentRuntime } from '@profer/shared'
import type { AppSettings } from '../../types'

/** 内存缓存：避免启动时多次 IPC 调用反复读磁盘 */
let _settingsCache: AppSettings | null = null

/** 已废弃的设置键（2026-09 Tablet* → Pocket* 改名前的写入形式），仅供读取时归一，不再写入 */
interface LegacyTabletModeSettings {
  tabletModeEnabled?: boolean
  tabletModePort?: number
  pluginSystemEnabled?: boolean
  openEpistemicModeEnabled?: boolean
}

function getDefaultSettings(): AppSettings {
  return {
    themeMode: DEFAULT_THEME_MODE,
    interfaceVariant: DEFAULT_INTERFACE_VARIANT,
    onboardingCompleted: false,
    environmentCheckSkipped: false,
    notificationsEnabled: true,
    // 空闲自检默认关闭：Goal 的常规节奏是「一轮结束后立即续跑」，
    // 30 分钟间隔只在用户明确选择「无人值守」时才启用，否则会把正常 Goal 降速成半小时一轮。
    goalIdleCheckinMinutes: 0,
    goalIdleCheckinMaxCount: 3,
    goalProposalPolicy: 'alwaysAsk',
    showCreditsInSidebar: true,
    userMessagePosition: DEFAULT_USER_MESSAGE_POSITION,
    previewModePreference: DEFAULT_PREVIEW_OPEN_MODE,
    // 手动确认已读：默认关闭（关闭态行为与既有一致）
    manualReadConfirmEnabled: false,
    feishuSessionMirror: { mode: 'off' },
    agentRuntime: DEFAULT_AGENT_RUNTIME,
    // 建议新开会话默认关闭：这是常驻提示，应由用户主动开启。
    handoffSuggestTurnCount: DEFAULT_HANDOFF_SUGGEST_TURN_COUNT,
    developerModeEnabled: false,
  }
}

/** 轮数阈值归一：非数字/负数按关闭处理，超上限截断，小数取整。 */
export function normalizeHandoffSuggestTurnCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HANDOFF_SUGGEST_TURN_COUNT
  }
  return Math.min(Math.round(value), MAX_HANDOFF_SUGGEST_TURN_COUNT)
}

/**
 * 获取应用设置
 *
 * 首次调用从磁盘读取并缓存，后续调用直接返回缓存。
 * 写入（updateSettings）会同步更新缓存。
 */
export function getSettings(): AppSettings {
  if (_settingsCache) return _settingsCache

  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    _settingsCache = getDefaultSettings()
    return _settingsCache
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings> & LegacyTabletModeSettings
    // 2026-09 命名收敛（Tablet* → Pocket*）：旧版写入的 tabletMode* 键归一为 pocketMode*，
    // 归一后旧键不再写回文件，老用户的「移动模式」开关与自定义端口保持不变。
    const { tabletModeEnabled, tabletModePort, pluginSystemEnabled, openEpistemicModeEnabled: _openEpistemicModeEnabled, ...data } = parsed
    const developerModeEnabled = data.developerModeEnabled ?? pluginSystemEnabled ?? false
    _settingsCache = {
      ...data,
      pocketModeEnabled: data.pocketModeEnabled ?? tabletModeEnabled,
      pocketModePort: data.pocketModePort ?? tabletModePort,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      showCreditsInSidebar: data.showCreditsInSidebar !== false,
      userMessagePosition: data.userMessagePosition === 'left' ? 'left' : DEFAULT_USER_MESSAGE_POSITION,
      // 旧 settings.json 无该键时归一为 'tab'（独立标签页）；只有字面 'split' 才视为分屏
      previewModePreference: data.previewModePreference === 'split' ? 'split' : DEFAULT_PREVIEW_OPEN_MODE,
      // 旧 settings.json 无该键时归一为 false；只有字面 true 才视为开启
      manualReadConfirmEnabled: data.manualReadConfirmEnabled === true,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      agentRuntime: normalizeAgentRuntime(data.agentRuntime),
      handoffSuggestTurnCount: normalizeHandoffSuggestTurnCount(data.handoffSuggestTurnCount),
      goalProposalPolicy: normalizeGoalProposalPolicy(data.goalProposalPolicy),
      developerModeEnabled,
    }
    return _settingsCache
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    _settingsCache = getDefaultSettings()
    return _settingsCache
  }
}

/**
   * 更新应用设置
   *
   * 合并更新字段并写入文件，同步更新内存缓存。
   */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  // 确保缓存已初始化
  if (!_settingsCache) getSettings()

  const supportedUpdates = { ...updates }
  delete (supportedUpdates as Partial<AppSettings> & { openEpistemicModeEnabled?: boolean }).openEpistemicModeEnabled
  const normalizedUpdates: Partial<AppSettings> = {
    ...supportedUpdates,
    ...(updates.agentRuntime !== undefined
      ? { agentRuntime: normalizeAgentRuntime(updates.agentRuntime) }
      : {}),
    ...(updates.developerModeEnabled === undefined && updates.pluginSystemEnabled !== undefined
      ? { developerModeEnabled: updates.pluginSystemEnabled }
      : {}),
  }
  if (updates.userMessagePosition !== undefined) {
    normalizedUpdates.userMessagePosition = updates.userMessagePosition === 'left' ? 'left' : DEFAULT_USER_MESSAGE_POSITION
  }
  if (updates.previewModePreference !== undefined) {
    normalizedUpdates.previewModePreference = updates.previewModePreference === 'split' ? 'split' : DEFAULT_PREVIEW_OPEN_MODE
  }
  if (updates.handoffSuggestTurnCount !== undefined) {
    normalizedUpdates.handoffSuggestTurnCount = normalizeHandoffSuggestTurnCount(updates.handoffSuggestTurnCount)
  }
  delete normalizedUpdates.pluginSystemEnabled
  const updated: AppSettings = {
    ..._settingsCache!,
    ...normalizedUpdates,
  }
  delete updated.pluginSystemEnabled

  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    _settingsCache = updated
    console.log('[设置] 已更新 keys:', Object.keys(normalizedUpdates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  for (const listener of settingsListeners) {
    try { listener() } catch { /* 监听者错误不影响已保存的设置 */ }
  }
  return updated
}

/** 清除内存缓存（测试用） */
export function clearSettingsCache(): void {
  _settingsCache = null
}

/** 宿主外观变化同步给隔离的插件页面。 */
const settingsListeners = new Set<() => void>()
export function subscribeSettingsChanges(listener: () => void): () => void {
  settingsListeners.add(listener)
  return () => { settingsListeners.delete(listener) }
}
