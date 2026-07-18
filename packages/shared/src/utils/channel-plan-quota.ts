import type { ProviderType } from '../types/channel'

/** 具备可查询窗口型订阅额度官方接口的渠道类型。普通 zhipu API 不等同于 GLM Coding Plan。 */
const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek',
  'kimi-coding',
  'minimax',
  'zhipu-coding',
])

export function supportsProviderPlanQuota(provider: ProviderType): boolean {
  return PLAN_QUOTA_PROVIDERS.has(provider)
}
