import type { ChannelCreateInput, ChannelUpdateInput } from '@profer/shared'

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
  if (input.provider !== 'openai-codex' && !input.baseUrl.trim()) return '请填写服务端点'
  if (input.provider !== 'ollama' && !usesOAuthCredentials(input.provider, input.credentialMode) && !input.apiKey.trim()) {
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
