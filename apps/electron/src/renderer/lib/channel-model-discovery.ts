import type { ChannelModel, FetchModelsResult } from '@profer/shared'

/**
 * 将一次远端模型发现结果安全地合并到渠道当前配置。
 *
 * 远端发现只是补充来源：请求失败时绝不能把失败视为权威空列表，
 * 否则编辑表单的自动保存会将用户已配置的模型错误清空。
 */
export function applyModelDiscoveryResult(
  current: ChannelModel[],
  result: FetchModelsResult,
): ChannelModel[] {
  if (!result.success) return current

  const discoveredById = new Map(result.models.map((model) => [model.id, model]))
  // 只有明确标记为远端发现过的旧模型才会随成功刷新被替换；
  // 未标记的历史模型兼容旧配置，视为用户本地配置并予以保留。
  const locallyConfigured = current.filter(
    (model) => model.source !== 'fetched' && !discoveredById.has(model.id),
  )

  const refreshedModels = result.models.map((model) => {
    const previous = current.find((candidate) => candidate.id === model.id)
    return {
      ...model,
      enabled: previous?.enabled ?? false,
      source: 'fetched' as const,
    }
  })

  return [...locallyConfigured, ...refreshedModels]
}
