import { type Channel, type ChannelPlanQuotaResult, type ProviderType } from '@profer/shared'

const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek', 'kimi-coding', 'minimax', 'zhipu', 'zhipu-coding', 'zhipu-coding-team', 'openai-codex',
])

export function supportsChannelPlanQuota(channel: Pick<Channel, 'provider' | 'baseUrl'> | null | undefined): boolean {
  if (!channel) return false
  return PLAN_QUOTA_PROVIDERS.has(channel.provider) || channel.baseUrl.includes('api.kimi.com/coding')
}

const PLAN_QUOTA_CACHE_MS = 60 * 1000
const PLAN_QUOTA_ERROR_CACHE_MS = 15 * 1000

interface CachedPlanQuota {
  result: ChannelPlanQuotaResult
  channelUpdatedAt?: number
}

const quotaCache = new Map<string, CachedPlanQuota>()
const inflightRequests = new Map<string, Promise<ChannelPlanQuotaResult>>()

function getCacheTtl(result: ChannelPlanQuotaResult): number {
  return result.supported ? PLAN_QUOTA_CACHE_MS : PLAN_QUOTA_ERROR_CACHE_MS
}

export function getCachedPlanQuota(channelId: string, channelUpdatedAt?: number): ChannelPlanQuotaResult | null {
  const cached = quotaCache.get(channelId)
  if (!cached || cached.channelUpdatedAt !== channelUpdatedAt) return null
  if (Date.now() - cached.result.updatedAt >= getCacheTtl(cached.result)) return null
  return cached.result
}

export async function fetchChannelPlanQuota(
  channelId: string,
  channelUpdatedAt?: number,
): Promise<ChannelPlanQuotaResult> {
  const cached = getCachedPlanQuota(channelId, channelUpdatedAt)
  if (cached) return cached

  const requestKey = `${channelId}:${channelUpdatedAt ?? ''}`
  const inflight = inflightRequests.get(requestKey)
  if (inflight) return inflight

  const request = window.electronAPI.getChannelPlanQuota(channelId)
    .then((result) => {
      quotaCache.set(channelId, { result, channelUpdatedAt })
      return result
    })
    .catch((error: unknown) => {
      const result: ChannelPlanQuotaResult = {
        supported: false,
        provider: 'custom',
        windows: [],
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : '订阅额度查询失败',
      }
      quotaCache.set(channelId, { result, channelUpdatedAt })
      return result
    })
    .finally(() => {
      inflightRequests.delete(requestKey)
    })

  inflightRequests.set(requestKey, request)
  return request
}
