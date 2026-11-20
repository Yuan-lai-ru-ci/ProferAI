import type { ChannelCreateInput, ChannelUpdateInput } from '@profer/shared'
import { isLocalModelProvider, resolveProviderNativeProtocol } from '@profer/shared'
import { inferAgentBaseUrl } from '@profer/core'

export interface SerialDraftQueue<T> {
  replace(draft: T): void
  flush(): Promise<void>
  cancel(): void
  settle(): Promise<void>
  hasPending(): boolean
}

/** 将草稿串行写入；失败时保留失败草稿，供下一次 flush 重试。 */
export function createSerialDraftQueue<T>(save: (draft: T) => Promise<void>): SerialDraftQueue<T> {
  let latest: T | undefined
  let inFlight: Promise<void> | null = null
  let generation = 0

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight
    const drain = async (): Promise<void> => {
      while (latest !== undefined) {
        const draft = latest
        latest = undefined
        const requestGeneration = generation
        try {
          await save(draft)
        } catch (error) {
          if (requestGeneration === generation && latest === undefined) latest = draft
          throw error
        }
      }
    }
    inFlight = drain().finally(() => { inFlight = null })
    return inFlight
  }

  return {
    replace(draft) { latest = draft },
    flush,
    cancel() { generation += 1; latest = undefined },
    async settle() { await inFlight?.catch(() => {}) },
    hasPending() { return latest !== undefined || inFlight !== null },
  }
}

export function isCurrentAsyncRequest(
  requestId: number,
  currentRequestId: number,
  requestKey: string,
  currentRequestKey: string,
): boolean {
  return requestId === currentRequestId && requestKey === currentRequestKey
}

/** 普通字段只发送增量；未编辑的凭据不会覆盖后台刷新或其它窗口的替换。 */
export function buildChannelDraftPatch(baseline: ChannelUpdateInput, draft: ChannelUpdateInput): ChannelUpdateInput {
  return Object.fromEntries(
    Object.entries(draft).filter(([field, value]) => value !== undefined
      && JSON.stringify(value) !== JSON.stringify(baseline[field as keyof ChannelUpdateInput])),
  )
}

export function validateChannelCreation(input: ChannelCreateInput): string | null {
  if (!input.name.trim()) return '请填写供应商名称'
  if (input.provider !== 'openai-codex' && !hasUsableEndpoint(input)) return '请填写服务端点'
  if (!isLocalModelProvider(input.provider) && !usesOAuthCredentials(input.provider, input.credentialMode) && !input.apiKey.trim()) {
    return '请填写 API Key'
  }
  if (!input.models.some((model) => model.enabled)) {
    return input.models.length === 0
      ? '尚未配置模型，请先从供应商获取或手动添加'
      : '尚未启用任何模型，请从可用模型中至少启用一个'
  }
  return null
}

export function usesOAuthCredentials(provider: ChannelCreateInput['provider'], mode: ChannelCreateInput['credentialMode']): boolean {
  return provider === 'openai-codex' || (provider === 'xai' && mode === 'oauth')
}

/**
 * 渠道是否具备可用的服务端点。
 *
 * 端点归属跟着内核走（与主进程 resolveAgentRuntimeBaseUrl 同规则）：
 * - Claude 内核恒消费 Anthropic/Agent 端点，Pi 内核只有 Anthropic 协议渠道才消费它
 * - Pi 走 OpenAI 等原生协议时仍必须填主地址
 * - 未勾任何内核时主地址兼作 Chat 地址，不能豁免
 *
 * 因此「只勾 Claude」与「只勾 Anthropic 协议的 Pi」都可以用 agentBaseUrl（或其官方默认值）
 * 独立满足端点要求，不再被空的 baseUrl 一刀切拒绝。
 */
function hasUsableEndpoint(input: ChannelCreateInput): boolean {
  if (input.baseUrl.trim()) return true
  const runtimes = input.agentRuntimes ?? []
  if (runtimes.length === 0) return false
  // Pi 走非 Anthropic 协议时必须填主地址，Agent 端点不能替它兜底。
  const piNeedsBaseUrl = runtimes.includes('pi')
    && resolveProviderNativeProtocol(input.provider, input.baseUrl) !== 'anthropic-messages'
  if (piNeedsBaseUrl) return false
  return Boolean(inferAgentBaseUrl(input.provider, input.baseUrl, input.agentBaseUrl)?.trim())
}
