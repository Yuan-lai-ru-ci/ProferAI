/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_AGENT_RUNTIME, DEFAULT_INTERFACE_VARIANT, DEFAULT_THEME_MODE } from '../../types'
import { normalizeAgentRuntime } from '@profer/shared'
import type { AppSettings } from '../../types'

/** 内存缓存：避免启动时多次 IPC 调用反复读磁盘 */
let _settingsCache: AppSettings | null = null

/** 已废弃的设置键（2026-09 Tablet* → Pocket* 改名前的写入形式），仅供读取时归一，不再写入 */
interface LegacyTabletModeSettings {
  tabletModeEnabled?: boolean
  tabletModePort?: number
}

function getDefaultSettings(): AppSettings {
  return {
    themeMode: DEFAULT_THEME_MODE,
    interfaceVariant: DEFAULT_INTERFACE_VARIANT,
    onboardingCompleted: false,
    environmentCheckSkipped: false,
    notificationsEnabled: true,
    feishuSessionMirror: { mode: 'off' },
    agentRuntime: DEFAULT_AGENT_RUNTIME,
  }
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
    const { tabletModeEnabled, tabletModePort, ...data } = parsed
    _settingsCache = {
      ...data,
      pocketModeEnabled: data.pocketModeEnabled ?? tabletModeEnabled,
      pocketModePort: data.pocketModePort ?? tabletModePort,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      interfaceVariant: data.interfaceVariant || DEFAULT_INTERFACE_VARIANT,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      agentRuntime: normalizeAgentRuntime(data.agentRuntime),
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

  const normalizedUpdates: Partial<AppSettings> = {
    ...updates,
    ...(updates.agentRuntime !== undefined
      ? { agentRuntime: normalizeAgentRuntime(updates.agentRuntime) }
      : {}),
  }
  const updated: AppSettings = {
    ..._settingsCache!,
    ...normalizedUpdates,
  }

  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    _settingsCache = updated
    console.log('[设置] 已更新 keys:', Object.keys(normalizedUpdates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}

/** 清除内存缓存（测试用） */
export function clearSettingsCache(): void {
  _settingsCache = null
}
