/**
 * 模型上下文窗口推断 — 单一 source of truth。
 *
 * 后端（agent-orchestrator 是否发 `context-1m-2025-08-07` beta）和
 * 前端（ContextUsageBadge 进度环分母 fallback）必须共用同一份判定，
 * 否则会出现"UI 显示 1M 但实际只 200K"或反过来的不一致。
 */

import type { ProviderType } from '../types/channel'

/** 默认上下文窗口（无法识别模型时使用） */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** 1M 上下文窗口 */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000

export interface ModelUsageContextInfo {
  contextWindow?: number
}

/**
 * 规范化用于上下文能力匹配的模型 ID。
 * 去除 Claude Agent SDK 私有的 `[1m]` 后缀，并保留最后一个路径段以兼容网关前缀。
 */
export function normalizeContextModelId(modelId?: string): string | undefined {
  const trimmed = modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/').filter(Boolean)
  return segments.at(-1) ?? trimmed
}

/** 仅 DeepSeek V4 Pro / Flash 是当前产品已确认的 1M DeepSeek 模型。 */
export function isDeepSeekV4Model(modelId?: string): boolean {
  const model = normalizeContextModelId(modelId)
  return model != null && /^deepseek-v4-(?:pro|flash)$/.test(model)
}

/**
 * 判断模型是否支持 1M context window beta（context-1m-2025-08-07）。
 *
 * 当前支持：
 * - Claude Sonnet 4 / 4.5 / 4.6
 * - Claude Opus 4.6 / 4.7 / 4.8
 * - Claude Fable 5
 * - DeepSeek V4 系列
 * - 小米 MiMo V2.5 / V2.5 Pro / V2 Pro
 * - 智谱 GLM-5.2、GLM-X-Preview[1m]
 * - MiniMax M3（智谱式兼容端点支持）
 *
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/context-windows
 */
export function supports1MContext(modelId: string): boolean {
  if (!modelId) return false
  const raw = modelId.trim().toLowerCase()
  const hasExplicit1MSuffix = /\[1m\]$/i.test(raw)
  const m = normalizeContextModelId(modelId)
  if (!m || m.includes('haiku')) return false
  if (m.includes('claude')) {
    if (m.includes('sonnet-4')) return true
    if (m.includes('opus-4-6') || m.includes('opus-4-7') || m.includes('opus-4-8')) return true
    if (m.includes('fable-5')) return true
    return false
  }
  if (isDeepSeekV4Model(m)) return true
  if (m.includes('mimo-v2.5') || m.includes('mimo-v2-pro')) return true
  if (m.includes('glm-5.2')) return true
  if (m.includes('glm-x-preview') && hasExplicit1MSuffix) return true
  if (m.includes('minimax-m3')) return true
  // Kimi K3（短 ID 需精确匹配，避免误匹配其他含 "k3" 子串的模型名）
  if (m === 'k3' || m.startsWith('k3[')) return true
  return false
}

/**
 * 按模型名推断 contextWindow（token 数）。
 *
 * SDK 流式过程中不返回此字段，只有 result 消息的 modelUsage 才带（且部分渠道不返回）。
 * 本函数提供一个按模型家族的 fallback，保证进度环永远有分母可用。
 */
export function inferContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  if (supports1MContext(model)) return ONE_MILLION_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 为支持 1M 上下文的模型追加 `[1m]` 后缀，让 SDK/API 协商大上下文窗口。
 * 不支持 1M 的模型原样返回；已带后缀的幂等跳过。
 *
 * 使用位置：构建 SDK query options 时对 modelId 做转换。
 */
const AGENT_SDK_1M_PROVIDER_RULES: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: ['claude-sonnet-4', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5'],
  'kimi-api': ['k3'],
  'kimi-coding': ['k3'],
  'zhipu-coding': ['glm-5.2'],
  minimax: ['minimax-m3'],
  xiaomi: ['mimo-v2.5'],
  'xiaomi-token-plan': ['mimo-v2.5'],
}

function matchesAgentSdk1MRule(modelId: string, rule: string): boolean {
  const model = normalizeContextModelId(modelId)
  return model != null && (rule === 'k3' ? model === 'k3' || model.startsWith('k3[') : model.includes(rule))
}

/**
 * 为经过验证的 provider/model 组合选择 Claude SDK 1M 变体。
 * boolean 参数保留给已显式完成协议协商的调用方；provider 参数不会向未知兼容端点修改模型 ID。
 */
export function resolveAgentSdkModelId(modelId: string, provider?: ProviderType): string
export function resolveAgentSdkModelId(modelId: string, enable1MContext: boolean): string
export function resolveAgentSdkModelId(modelId: string, providerOrEnabled?: ProviderType | boolean): string {
  if (!modelId || /\[1m\]$/i.test(modelId)) return modelId
  if (typeof providerOrEnabled === 'boolean') return providerOrEnabled ? `${modelId}[1m]` : modelId
  if (!providerOrEnabled) return modelId
  if (providerOrEnabled === 'deepseek') {
    return isDeepSeekV4Model(modelId) ? `${modelId}[1m]` : modelId
  }
  const rules = AGENT_SDK_1M_PROVIDER_RULES[providerOrEnabled]
  if (!rules?.some(rule => matchesAgentSdk1MRule(modelId, rule))) return modelId
  return `${modelId}[1m]`
}

/** 按实际 provider 推断 Agent SDK 上下文窗口，不向未知代理假设 1M 协议。 */
export function inferAgentSdkContextWindow(modelId: string | undefined, provider?: ProviderType): number | undefined {
  if (!modelId) return undefined
  return resolveAgentSdkModelId(modelId, provider) !== modelId || /\[1m\]$/i.test(modelId)
    ? ONE_MILLION_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * 从多模型 result 选择本轮上下文窗口。
 * 优先选择配置的主模型；无法定位时使用最大的实测窗口，避免误取首个子 Agent 模型。
 */
export function resolveContextWindowFromModelUsage(
  modelUsage?: Record<string, ModelUsageContextInfo>,
  preferredModelId?: string,
  fallbackModelId?: string,
): number | undefined {
  const entries = Object.entries(modelUsage ?? {})
  const canonicalize = (modelId?: string) => modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  const preferredCanonical = canonicalize(preferredModelId)

  if (preferredCanonical) {
    const exactEntry = entries.find(([modelId]) => canonicalize(modelId) === preferredCanonical)
    if (exactEntry) return exactEntry[1].contextWindow ?? inferContextWindow(exactEntry[0])

    const preferredTail = normalizeContextModelId(preferredModelId)
    const tailMatches = entries.filter(([modelId]) => normalizeContextModelId(modelId) === preferredTail)
    if (tailMatches.length === 1) {
      const [modelId, info] = tailMatches[0]!
      return info.contextWindow ?? inferContextWindow(modelId)
    }
  }

  let largest: number | undefined
  for (const [modelId, info] of entries) {
    const window = info.contextWindow ?? inferContextWindow(modelId)
    if (window != null && (largest == null || window > largest)) largest = window
  }
  return largest ?? inferContextWindow(fallbackModelId)
}
