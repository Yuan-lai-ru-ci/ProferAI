import { type Channel, type ChannelPlanQuotaResult, type ProviderType } from '@profer/shared'

const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek', 'kimi-coding', 'minimax', 'zhipu-coding', 'openai-codex',
])

export function supportsChannelPlanQuota(channel: Pick<Channel, 'provider' | 'baseUrl' | 'serverManaged'> | null | undefined): boolean {
  // Profer 代管渠道的额度由 Profer 账户计费，不应使用其服务端凭据查询第三方账户数据。
  if (!channel || channel.serverManaged) return false
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
  // result 必须有效：历史缺陷曾把 undefined 写入缓存（IPC 实现缺失/平板 stub 兜底），
  // 二次查询读 cached.result.updatedAt 会抛 TypeError。
  if (!cached || !cached.result) return null
  // 仅在调用方显式传入渠道版本时才做严格一致性校验；否则信任结果内部自带的 channelUpdatedAt，
  // 避免「主进程回传版本后，未传参的二次查询因 undefined !== 实际版本而误判缓存失效」。
  if (channelUpdatedAt != null && cached.channelUpdatedAt !== channelUpdatedAt) return null
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
      // 兜底：IPC 实现异常或平板 stub 返回 undefined 时，写入明确的“不支持”结果，
      // 避免缓存中出现 result: undefined（二次查询会读 result.updatedAt 崩溃）。
      if (!result || typeof result !== 'object') {
        result = {
          supported: false,
          provider: 'custom',
          windows: [],
          updatedAt: Date.now(),
          message: '订阅额度查询失败',
        }
      }
      // 回写时带上主进程回传的渠道版本，下次调用即使没显式传 channelUpdatedAt 也能命中缓存。
      quotaCache.set(channelId, { result, channelUpdatedAt: result.channelUpdatedAt ?? channelUpdatedAt })
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
