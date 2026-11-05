import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  normalizeReasoningLevel,
  resolveReasoningProfile,
  type AgentThinkingLevel,
  type ReasoningProfile,
} from '@profer/shared'

type ProviderPayload = Record<string, unknown>

export interface MistralReasoningRequestSettings {
  profile?: ReasoningProfile
  thinkingLevel?: AgentThinkingLevel
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

function hasOwn(payload: ProviderPayload, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key)
}

/**
 * Pi 的 `before_provider_request` 收到的是序列化前的 provider payload：
 * Mistral 适配器此时用的还是 camelCase（`promptMode` / `reasoningEffort`），
 * 之后才由 `toMistralWirePayload` 换成 snake_case。两种拼写都兼容，避免将来
 * hook 时机变化时静默失效。
 */
function reasoningKeys(payload: ProviderPayload): { promptMode: string; reasoningEffort: string } {
  const wireShaped = (hasOwn(payload, 'prompt_mode') || hasOwn(payload, 'reasoning_effort'))
    && !hasOwn(payload, 'promptMode')
    && !hasOwn(payload, 'reasoningEffort')
  return wireShaped
    ? { promptMode: 'prompt_mode', reasoningEffort: 'reasoning_effort' }
    : { promptMode: 'promptMode', reasoningEffort: 'reasoningEffort' }
}

/**
 * 把 Pi 按模型 ID 猜出来的 Mistral 推理参数统一改成 reasoning_effort。
 *
 * Pi 0.86.1 的 `usesReasoningEffort` 只认四个写死的模型 ID，其余声明 reasoning
 * 的模型一律发 `prompt_mode: 'reasoning'`。实测 Mistral 的 magistral-* 和托管的
 * deepseek-v4-1-flash 也接受 `reasoning_effort`，而 `prompt_mode` 在未开通的账号
 * 上会 400（code 3051）；Profer 已按实测把这两类模型声明为推理模型，这里必须把
 * Pi 补上的 `promptMode` 换成 `reasoningEffort`，否则一开思考就失败。
 *
 * 关闭思考时两个字段都不保留：Mistral 只接受 none / high，省略参数即按模型默认
 * （实测不产出 reasoning_tokens）。
 */
export function injectMistralReasoningLevel(
  payload: unknown,
  settings: MistralReasoningRequestSettings,
): unknown {
  if (!isProviderPayload(payload)) return payload
  // 没有会话级档位就不改写：profile.normalize(undefined) 会落到 high，
  // 那会把「未指定」错当成「开启思考」。
  if (!settings.thinkingLevel) return payload

  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  const profile = settings.profile ?? resolveReasoningProfile({
    modelId,
    transport: 'mistral-conversations',
  })
  const encoding = profile?.encodings['mistral-conversations']
  if (encoding?.kind !== 'provider-toggle') return payload

  const normalizedLevel = normalizeReasoningLevel(profile, settings.thinkingLevel)
  if (!normalizedLevel) return payload

  const keys = reasoningKeys(payload)
  const hasPromptMode = hasOwn(payload, keys.promptMode) || hasOwn(payload, 'prompt_mode') || hasOwn(payload, 'promptMode')
  const hasReasoningEffort = hasOwn(payload, keys.reasoningEffort) || hasOwn(payload, 'reasoning_effort') || hasOwn(payload, 'reasoningEffort')

  if (normalizedLevel === 'off') {
    if (!hasPromptMode && !hasReasoningEffort) return payload
    const {
      promptMode: _promptMode,
      prompt_mode: _promptModeWire,
      reasoningEffort: _reasoningEffort,
      reasoning_effort: _reasoningEffortWire,
      ...body
    } = payload
    return body
  }

  const effort = encoding.effortMap[normalizedLevel]
  if (typeof effort !== 'string') return payload

  const {
    promptMode: _promptMode,
    prompt_mode: _promptModeWire,
    ...body
  } = payload
  if (!hasPromptMode && body[keys.reasoningEffort] === effort) return payload
  return { ...body, [keys.reasoningEffort]: effort }
}

/** Pi inline extension for Mistral native reasoning requests. */
export function createMistralReasoningRequestExtension(
  settings: MistralReasoningRequestSettings,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = injectMistralReasoningLevel(event.payload, settings)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}
