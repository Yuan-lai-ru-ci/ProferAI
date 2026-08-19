/**
 * Chat 工具配置服务。
 *
 * 管理 ~/.profer/chat-tools.json 的工具开关和凭据。GPT Image 的 BYOK Key
 * 只以加密字段保存在主进程配置中，绝不通过 IPC 回传到 renderer。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getChatToolsConfigPath } from './config-paths'
import { decryptToken, encryptToken } from './token-crypto'
import type {
  ChatToolsFileConfig,
  ChatToolState,
  ChatToolMeta,
} from '@profer/shared'

export type GptImageMode = 'official' | 'byok'

export interface GptImageCredentials {
  mode: GptImageMode
  apiKey: string
  baseUrl: string
  model: string
}

/** 默认配置 */
const DEFAULT_CONFIG: ChatToolsFileConfig = {
  toolStates: {
    memory: { enabled: true },
    'agent-mode-recommend': { enabled: true },
    'web-search': { enabled: false },
    'gpt-image': { enabled: false },
  },
  toolCredentials: {},
  customTools: [],
}

function normalizeGptImageMode(value: string | undefined): GptImageMode {
  return value === 'byok' ? 'byok' : 'official'
}

/** 将旧版明文 apiKey 升级为加密 apiKeyEncrypted；调用方负责保存。 */
function migrateGptImageCredentials(config: ChatToolsFileConfig): boolean {
  const raw = config.toolCredentials['gpt-image']
  if (!raw) return false
  let changed = false
  if (!raw.mode) {
    // 老版本只有自带 Key 配置；保留其原有可用语义，而空配置才默认官方模式。
    raw.mode = raw.apiKey || raw.apiKeyEncrypted ? 'byok' : 'official'
    changed = true
  }
  if (raw.apiKey && !raw.apiKeyEncrypted) {
    raw.apiKeyEncrypted = encryptToken(raw.apiKey)
    delete raw.apiKey
    changed = true
  }
  return changed
}

/** 读取工具配置 */
export function getChatToolsConfig(): ChatToolsFileConfig {
  const filePath = getChatToolsConfigPath()
  if (!existsSync(filePath)) return structuredClone(DEFAULT_CONFIG)

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<ChatToolsFileConfig>
    const config: ChatToolsFileConfig = {
      toolStates: { ...DEFAULT_CONFIG.toolStates, ...data.toolStates },
      toolCredentials: data.toolCredentials ?? {},
      customTools: data.customTools ?? [],
    }
    // 读取旧配置时一次性迁移，迁移本身幂等。
    if (migrateGptImageCredentials(config)) saveChatToolsConfig(config)
    return config
  } catch (error) {
    console.error('[Chat 工具配置] 读取失败:', error)
    return structuredClone(DEFAULT_CONFIG)
  }
}

/** 保存工具配置 */
export function saveChatToolsConfig(config: ChatToolsFileConfig): void {
  const filePath = getChatToolsConfigPath()
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
    console.log('[Chat 工具配置] 已保存')
  } catch (error) {
    console.error('[Chat 工具配置] 保存失败:', error)
    throw new Error('保存 Chat 工具配置失败')
  }
}

/** 更新单个工具的开关状态 */
export function updateToolState(toolId: string, state: ChatToolState): void {
  const config = getChatToolsConfig()
  config.toolStates[toolId] = state
  saveChatToolsConfig(config)
}

/**
 * 更新工具凭据。GPT Image 是特例：apiKey 输入会在主进程立即加密；空 apiKey
 * 表示“不改动已保存 Key”，从而支持 renderer 不回显密钥的重新编辑体验。
 */
export function updateToolCredentials(
  toolId: string,
  credentials: Record<string, string>,
): void {
  const config = getChatToolsConfig()
  if (toolId !== 'gpt-image') {
    config.toolCredentials[toolId] = credentials
    saveChatToolsConfig(config)
    return
  }

  const existing = config.toolCredentials['gpt-image'] ?? {}
  const next: Record<string, string> = {
    ...existing,
    mode: normalizeGptImageMode(credentials.mode),
    baseUrl: credentials.baseUrl?.trim() ?? existing.baseUrl ?? '',
    model: credentials.model?.trim() ?? existing.model ?? '',
  }
  if (credentials.apiKey?.trim())
    next.apiKeyEncrypted = encryptToken(credentials.apiKey.trim())
  delete next.apiKey
  config.toolCredentials['gpt-image'] = next
  saveChatToolsConfig(config)
}

/** 获取工具开关状态（不存在时返回默认关闭） */
export function getToolState(toolId: string): ChatToolState {
  const config = getChatToolsConfig()
  return config.toolStates[toolId] ?? { enabled: false }
}

/** 主进程专用：取得已解密 GPT Image 凭据。 */
export function getGptImageCredentials(): GptImageCredentials {
  const raw = getChatToolsConfig().toolCredentials['gpt-image'] ?? {}
  let apiKey = ''
  if (raw.apiKeyEncrypted) {
    try {
      apiKey = decryptToken(raw.apiKeyEncrypted)
    } catch (error) {
      console.error('[Chat 工具配置] GPT Image Key 解密失败:', error)
    }
  }
  return {
    mode: normalizeGptImageMode(raw.mode),
    apiKey,
    baseUrl: raw.baseUrl ?? '',
    model: raw.model ?? '',
  }
}

/**
 * 获取工具凭据。GPT Image 的 Key 不可被 renderer 或通用 IPC 读取；仅返回
 * mode/地址/模型与 hasApiKey 状态。其他工具保持现有兼容行为。
 */
export function getToolCredentials(toolId: string): Record<string, string> {
  if (toolId !== 'gpt-image')
    return getChatToolsConfig().toolCredentials[toolId] ?? {}
  const credentials = getGptImageCredentials()
  return {
    mode: credentials.mode,
    baseUrl: credentials.baseUrl,
    model: credentials.model,
    hasApiKey: credentials.apiKey ? 'true' : 'false',
  }
}

/** 添加自定义工具 */
export function addCustomTool(meta: ChatToolMeta): void {
  const config = getChatToolsConfig()
  config.customTools = config.customTools.filter((t) => t.id !== meta.id)
  config.customTools.push(meta)
  config.toolStates[meta.id] = { enabled: false }
  saveChatToolsConfig(config)
}

/** 删除自定义工具 */
export function deleteCustomTool(toolId: string): void {
  const config = getChatToolsConfig()
  config.customTools = config.customTools.filter((t) => t.id !== toolId)
  delete config.toolStates[toolId]
  delete config.toolCredentials[toolId]
  saveChatToolsConfig(config)
}
