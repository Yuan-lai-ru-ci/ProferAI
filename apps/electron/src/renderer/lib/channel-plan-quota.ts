import type { Channel, ProviderType } from '@proma/shared'

const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek',
  'kimi-coding',
  'minimax',
  'zhipu',
  'zhipu-coding',
  'zhipu-coding-team',
])

export function supportsChannelPlanQuota(channel: Pick<Channel, 'provider' | 'baseUrl'> | null | undefined): boolean {
  if (!channel) return false
  if (PLAN_QUOTA_PROVIDERS.has(channel.provider)) return true
  return channel.baseUrl.includes('api.kimi.com/coding')
}
