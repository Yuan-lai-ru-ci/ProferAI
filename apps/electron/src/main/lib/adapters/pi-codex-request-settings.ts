/**
 * Pi Codex 请求设置扩展（#1268 GPT-5.x 推理档位跨会话记忆）
 *
 * 将 Profer 的推理档位 + Fast Mode 映射为 OpenAI provider 请求参数。
 * 扩展在 Pi 的 before_provider_request 钩子中注入，覆盖首轮、续轮和
 * tool continuation 的全部 provider request。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AgentThinkingLevel } from '@profer/shared'
import { isCodexFastModeSupportedModel, isDeepSeekV4Model } from '@profer/shared'
import { injectCodexFastMode as doInjectCodexFastMode } from './pi-codex-fast-mode'

type ProviderPayload = Record<string, unknown>

// ── re-export from pi-codex-fast-mode.ts ──

export { injectCodexFastMode, withCodexFastModeServiceTier, CODEX_FAST_MODE_SERVICE_TIER } from './pi-codex-fast-mode'

// ── reasoning.effort 映射 ──

/**
 * AgentThinkingLevel → OpenAI reasoning.effort 映射。
 *
 * - 'off' → 'none'（显式写入，GPT-5.x 服务端默认 medium，不写就会用默认）
 * - 'minimal' → 'low'（UI 标签"最小"，底层复用 low 档位）
 * - 'low' / 'medium' / 'high' / 'xhigh' 不变
 */
const THINKING_LEVEL_TO_EFFORT: Record<AgentThinkingLevel, string> = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

/**
 * 为 Codex Responses provider 请求注入 OpenAI reasoning.effort。
 *
 * 剥离 reasoning.mode（ChatGPT Codex OAuth 不支持该字段），
 * 并显式写入 reasoning.effort（GPT-5.x 默认 medium，off 必须显式 none）。
 */
export function injectOpenAIThinkingLevel(
  payload: unknown,
  thinkingLevel: AgentThinkingLevel,
): unknown {
  if (!isProviderPayload(payload)) return payload
  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  if (!isCodexFastModeSupportedModel(modelId)) return payload

  const effort = THINKING_LEVEL_TO_EFFORT[thinkingLevel] ?? 'none'

  // 剥离 reasoning.mode（OAuth 不支持），写入 reasoning.effort
  return {
    ...payload,
    reasoning: {
      ...(payload.reasoning as Record<string, unknown> ?? {}),
      effort,
    },
  }
}

/**
 * 创建统一 Codex 请求设置 Pi 扩展（推理档位 + Fast Mode）。
 *
 * 同时处理 reasoning.effort 和 service_tier 注入，避免多次遍历 payload。
 */
export function createCodexRequestSettingsExtension(settings: {
  thinkingLevel: AgentThinkingLevel
  fastMode?: boolean
}): (pi: ExtensionAPI) => void {
  const { thinkingLevel, fastMode } = settings
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      let updated = event.payload

      // 注入推理档位
      updated = injectOpenAIThinkingLevel(updated, thinkingLevel)

      // 注入 Fast Mode
      if (fastMode) {
        updated = doInjectCodexFastMode(updated)
      }

      return updated === event.payload ? undefined : updated
    })
  }
}

/**
 * 为 DeepSeek V4 Anthropic-compatible 请求应用其专有思考协议。
 *
 * Pi 0.80.9 会把通用 reasoning 模型转成旧式 `budget_tokens` 请求；DeepSeek V4
 * 需要无 budget 的 thinking 开关，并通过 `output_config.effort` 控制强度。
 */
export function injectDeepSeekV4ThinkingSettings(payload: unknown, thinkingEnabled: boolean): unknown {
  if (!isProviderPayload(payload)) return payload
  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  if (!isDeepSeekV4Model(modelId)) return payload

  if (!thinkingEnabled) {
    return {
      ...payload,
      thinking: { type: 'disabled' },
    }
  }

  return {
    ...payload,
    thinking: { type: 'enabled' },
    output_config: {
      ...(isProviderPayload(payload.output_config) ? payload.output_config : {}),
      effort: 'max',
    },
  }
}

/** 为 Pi + DeepSeek V4 的每轮 Anthropic Messages 请求注入思考开关与 max 强度。 */
export function createDeepSeekV4RequestSettingsExtension(settings: {
  thinkingEnabled: boolean
}): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updated = injectDeepSeekV4ThinkingSettings(event.payload, settings.thinkingEnabled)
      return updated === event.payload ? undefined : updated
    })
  }
}
