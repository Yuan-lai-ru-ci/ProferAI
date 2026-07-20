import type { Channel, ProviderType } from '@profer/shared'
import { getTeamAuthWithRefresh } from './auth-service'
import { decryptApiKey, isCommercialMode, resolveChannelAgentBaseUrl } from './channel-manager'
import { isCommercialBuild } from './build-target'

/** 单次 Agent 请求专属的已解析凭据；严禁写入 process.env 或日志。 */
export interface ResolvedRuntimeCredentials {
  apiKey: string
  baseUrl: string | undefined
  provider: ProviderType
  /** 官方团队渠道使用 Bearer token，不能按普通 API key 处理。 */
  forceBearerAuth: boolean
}

export type ResolveRuntimeCredentialsResult =
  | { ok: true; credentials: ResolvedRuntimeCredentials }
  | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' }

/**
 * 集中解析运行时凭据。每次调用只返回本轮不可变数据，避免并发 session 通过 process.env 串用 token。
 * 渠道存在性/启用性仍由 Orchestrator 的既有 preflight 负责，避免改变产品错误优先级。
 */
export async function resolveRuntimeCredentials(
  channel: Pick<Channel, 'id' | 'provider' | 'baseUrl' | 'agentBaseUrl'>,
): Promise<ResolveRuntimeCredentialsResult> {
  const isOfficialChannel = channel.id.startsWith('newapi-')
  const forceBearerAuth = (isCommercialBuild() || isCommercialMode()) && isOfficialChannel

  if (forceBearerAuth) {
    const auth = await getTeamAuthWithRefresh()
    if (!auth) return { ok: false, code: 'token_expired' }
    return {
      ok: true,
      credentials: {
        apiKey: auth.proxyToken || auth.token,
        baseUrl: `${auth.baseUrl}/v1/proxy`,
        provider: channel.provider,
        forceBearerAuth: true,
      },
    }
  }

  try {
    return {
      ok: true,
      credentials: {
        apiKey: decryptApiKey(channel.id),
        baseUrl: resolveChannelAgentBaseUrl(channel),
        provider: channel.provider,
        forceBearerAuth: false,
      },
    }
  } catch {
    return { ok: false, code: 'api_key_decrypt_failed' }
  }
}
