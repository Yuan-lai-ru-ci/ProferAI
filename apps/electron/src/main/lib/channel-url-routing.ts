import type { Channel, ChannelModel, ChannelsConfig, ProviderType } from '@profer/shared'
import { PROVIDER_DEFAULT_URLS, inferAgentRuntimeModes } from '@profer/shared'
import { inferAgentBaseUrl, isOfficialDeepSeekAgentUrl, isOfficialDeepSeekV1Url, normalizeBaseUrl } from '@profer/core'

export { inferAgentBaseUrl }

export function normalizeChannelForCurrentSchema(channel: Channel): { channel: Channel; changed: boolean } {
  let changed = false
  let next: Channel = { ...channel }

  if (next.provider === 'xai' && !next.baseUrl?.trim()) {
    next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.xai }
    changed = true
  }

  // apiProtocol 只属于 xAI API Key 渠道；换供应商/切订阅 OAuth 后必须清掉，
  // 避免旧协议残留影响后续切回时的地址预览与请求分派。
  if (next.provider !== 'xai' && next.apiProtocol !== undefined) {
    next = { ...next, apiProtocol: undefined }
    changed = true
  } else if (next.provider === 'xai' && next.credentialMode === 'oauth' && next.apiProtocol !== undefined) {
    next = { ...next, apiProtocol: undefined }
    changed = true
  }

  if (next.provider === 'deepseek') {
    // 只迁移官方 DeepSeek 的 Anthropic 地址；用户自定义网关可能也包含
    // /anthropic，不能再被硬编码覆盖回 api.deepseek.com。
    if (isOfficialDeepSeekAgentUrl(next.baseUrl)) {
      next = {
        ...next,
        agentBaseUrl: next.agentBaseUrl?.trim() || normalizeBaseUrl(next.baseUrl),
        baseUrl: PROVIDER_DEFAULT_URLS.deepseek,
      }
      changed = true
    } else if (isOfficialDeepSeekV1Url(next.baseUrl)) {
      next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.deepseek }
      changed = true
    } else if (!next.baseUrl?.trim()) {
      next = { ...next, baseUrl: PROVIDER_DEFAULT_URLS.deepseek }
      changed = true
    }
  }

  // agentBaseUrl 是按 baseUrl 推导出来的派生值，不能落库：一旦写回持久化，用户之后改
  // 主 baseUrl 时旧值会被当成「显式覆盖」继续生效（换了地址，Agent 还打旧地址）。
  // 因此只保留与推导值不同的显式指定；其余情况删除字段，交给运行时按当前 baseUrl 推导。
  // 注意 serverManaged 渠道由服务端带来的显式 agentBaseUrl 同样只在「等于推导值」时清理。
  const derivedAgentBaseUrl = inferAgentBaseUrl(next.provider, next.baseUrl, undefined)
  const explicitAgentBaseUrl = next.agentBaseUrl?.trim()
  if (!explicitAgentBaseUrl) {
    if (next.agentBaseUrl !== undefined) {
      next = { ...next, agentBaseUrl: undefined }
      changed = true
    }
  } else if (derivedAgentBaseUrl && normalizeBaseUrl(explicitAgentBaseUrl) === normalizeBaseUrl(derivedAgentBaseUrl)) {
    next = { ...next, agentBaseUrl: undefined }
    changed = true
  } else if (explicitAgentBaseUrl !== next.agentBaseUrl) {
    next = { ...next, agentBaseUrl: explicitAgentBaseUrl }
    changed = true
  }

  // 静默迁移：老配置没有勾选字段，按现有 provider 规则推导一次并写回。
  // 推导结果与迁移前的门禁行为等价，用户不会感知到能力变化。
  if (!next.agentRuntimes) {
    next = { ...next, agentRuntimes: inferAgentRuntimeModes(next) }
    changed = true
  }

  return { channel: next, changed }
}

export function normalizeConfigForCurrentSchema(config: ChannelsConfig): { config: ChannelsConfig; changed: boolean } {
  let changed = false
  const channels = config.channels.map((channel) => {
    const result = normalizeChannelForCurrentSchema(channel)
    if (result.changed) changed = true
    return result.channel
  })
  return { config: { ...config, channels }, changed }
}

/**
 * 合并服务端下发的渠道模型与本地状态。
 *
 * 服务端只负责「有哪些模型」，以下两项属于用户本地决定，不得被同步洗掉：
 * - 模型级 enabled（用户启停）
 * - 模型上的 1M 勾选（context1m）
 *
 * 注意：这里的 localModels 只会是「同 ID 的服务端渠道」上次同步留下的本地记录
 * （官方/模型族渠道在 UI 上没有 1M 开关，用户改不了 context1m），
 * 不会与用户自配渠道（id 不同）发生交叉。
 */
export function mergeServerChannelModels(
  serverModels: readonly Partial<ChannelModel>[],
  localModels: readonly ChannelModel[] | undefined,
): ChannelModel[] {
  return serverModels.map((model) => {
    const modelKey = model.id ?? model.name
    const localModel = localModels?.find((candidate) => candidate.id === modelKey)
    return {
      ...model,
      enabled: localModel ? localModel.enabled : model.enabled !== false,
      ...(localModel?.context1m !== undefined && { context1m: localModel.context1m }),
    } as ChannelModel
  })
}
