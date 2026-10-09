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
  discoveredSource: 'fetched' | 'builtin-catalog' = 'fetched',
): ChannelModel[] {
  if (!result.success) return current

  // 只有明确标记为远端发现过的旧模型才会随成功刷新被替换；
  // 未标记的历史模型兼容旧配置，视为用户本地配置并予以保留。
  const locallyConfigured = current.filter((model) => model.source !== 'fetched' && model.source !== 'builtin-catalog')
  const localIds = new Set(locallyConfigured.map((model) => model.id))
  const discoveredById = new Map(result.models.map((model) => [model.id, model]))

  const refreshedModels = [...discoveredById.values()].filter((model) => !localIds.has(model.id)).map((model) => {
    const previous = current.find((candidate) => candidate.id === model.id)
    return {
      ...model,
      enabled: previous?.enabled ?? false,
      // 1M 勾选是用户显式设置，远端发现只负责「清单里有哪些模型」，
      // 不能因为重新拉取就把它洗掉。
      ...(previous?.context1m !== undefined && { context1m: previous.context1m }),
      source: discoveredSource,
    }
  })

  return [...locallyConfigured, ...refreshedModels]
}

/** 自动发现尝试的幂等键：供应商 / 地址 / 凭证任一变化都视为一次新的尝试。 */
export function buildModelDiscoveryAttemptKey(input: {
  provider: string
  baseUrl: string
  apiKey: string
}): string {
  return `${input.provider}|${input.baseUrl.trim()}|${input.apiKey.trim()}`
}

/**
 * 是否应该自动向供应商发现模型清单。
 *
 * 渠道不再预置任何模型，清单必须来自端点：地址与凭证就绪、当前没有任何模型时自动拉取一次。
 * 同一个尝试组合只跑一次（错误凭证不反复打点），用户手动增删过模型或凭证还没加载完都不介入。
 */
export function shouldAutoDiscoverModels(input: {
  /** 是否具备发现条件（地址 + 凭证，Ollama 免 Key） */
  canDiscover: boolean
  /** 当前渠道的模型数量 */
  modelCount: number
  /** 是否正在请求 */
  fetching: boolean
  /** 编辑模式下明文凭证是否已加载完成 */
  awaitingCredentials: boolean
  /** 用户是否手动增删过模型 */
  userEditedModels: boolean
  /** 本次构建的尝试键 */
  attemptKey: string
  /** 已经尝试过的尝试键 */
  lastAttemptKey: string | null
}): boolean {
  if (input.awaitingCredentials || input.userEditedModels) return false
  if (!input.canDiscover || input.fetching || input.modelCount > 0) return false
  return input.lastAttemptKey !== input.attemptKey
}
