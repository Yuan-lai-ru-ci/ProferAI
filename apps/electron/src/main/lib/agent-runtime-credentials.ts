import type { AgentRuntime, Channel, CodexOAuthCredentials, ProviderType, XaiApiProtocol, XaiOAuthCredentials } from '@profer/shared'
import { PROVIDER_DEFAULT_URLS, resolveXaiCredentialMode } from '@profer/shared'
import { resolveEditionBearerToken } from '@profer/edition-contract'
import { decryptApiKey, persistCodexOAuthCredentials, persistXaiOAuthCredentials, resolveChannelAgentBaseUrl, resolveCodexOAuthCredentials, resolveXaiOAuthCredentials } from './channel-manager'
import { editionProviders } from './edition'
import { normalizePiApi } from './adapters/pi-model-registry'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'

/** 单次 Agent 请求专属的已解析凭据；严禁写入 process.env 或日志。 */
export interface ResolvedRuntimeCredentials {
  apiKey: string
  baseUrl: string | undefined
  provider: ProviderType
  /** 官方团队渠道使用 Bearer token，不能按普通 API key 处理。 */
  forceBearerAuth: boolean
  /** Codex 的完整 OAuth 凭据，交给 Pi 请求级 store 处理长期轮次刷新。 */
  codexOAuthCredentials?: CodexOAuthCredentials
  /** xAI 订阅模式的完整 OAuth 凭据，交给 Pi 原生 credential store。 */
  xaiOAuthCredentials?: XaiOAuthCredentials
  /** xAI API Key / OAuth；其他 provider 不设置。 */
  xaiCredentialMode?: 'api-key' | 'oauth'
  /** xAI API Key 渠道的请求协议；缺失时按 responses 处理。 */
  xaiApiProtocol?: XaiApiProtocol
}

export type ResolveRuntimeCredentialsResult =
  | { ok: true; credentials: ResolvedRuntimeCredentials }
  | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' | 'channel_not_found' }

/** Pi 协议由其模型注册层决定；Claude 的独立端点不能覆盖 OpenAI/Google 请求。 */
function resolveRuntimeBaseUrl(channel: Pick<Channel, 'provider' | 'baseUrl' | 'agentBaseUrl'>, runtime: AgentRuntime): string | undefined {
  if (runtime === 'claude') return resolveChannelAgentBaseUrl(channel)
  const nativeBaseUrl = channel.baseUrl?.trim() || PROVIDER_DEFAULT_URLS[channel.provider]
  if (channel.provider === 'deepseek' || channel.provider === 'ollama' || channel.provider === 'xai'
    || channel.provider === 'openai-codex'
    || normalizePiApi(channel.provider, nativeBaseUrl) !== 'anthropic-messages') {
    return nativeBaseUrl
  }
  return resolveChannelAgentBaseUrl(channel)
}

/**
 * 集中解析运行时凭据。每次调用只返回本轮不可变数据，避免并发 session 通过 process.env 串用 token。
 * 渠道存在性/启用性仍由 Orchestrator 的既有 preflight 负责，避免改变产品错误优先级。
 */
export async function resolveRuntimeCredentials(
  channel: Pick<Channel, 'id' | 'provider' | 'baseUrl' | 'agentBaseUrl' | 'credentialMode' | 'apiProtocol' | 'directDataPlane'>,
  runtime: AgentRuntime = 'claude',
): Promise<ResolveRuntimeCredentialsResult> {
  // 发行版切换：另一个发行版残留的渠道在当前版本里不可见（开源版里没有代管通道）。
  // 必须在这里拦住：它的 baseUrl 为空，往下会回落到厂商默认地址，用不属于该厂商的
  // 凭据去打真实接口，报一个和用户配置毫无关系的认证错误。
  // 用可选调用：能力缺失时退化为“可见”，不能让一个可选能力把整条执行链打断。
  const isVisible = editionProviders.channels?.isChannelVisible
  if (isVisible && !isVisible(channel)) return { ok: false, code: 'channel_not_found' }

  const forceBearerAuth = editionProviders.credentials.shouldUseBearerAuth(channel)

  const useDirectDataPlane = forceBearerAuth && channel.directDataPlane === true
  const baseUrl = resolveRuntimeBaseUrl(channel, runtime)

  if (forceBearerAuth) {
    if (useDirectDataPlane) {
      try {
        const apiKey = decryptApiKey(channel.id)
        return {
          ok: true,
          credentials: {
            apiKey,
            baseUrl,
            provider: channel.provider,
            forceBearerAuth: false,
          },
        }
      } catch {
        return { ok: false, code: 'api_key_decrypt_failed' }
      }
    }
    const auth = await editionProviders.account.getSession()
    if (!auth) return { ok: false, code: 'token_expired' }
    return {
      ok: true,
      credentials: {
        apiKey: resolveEditionBearerToken(auth),
        baseUrl: `${auth.baseUrl}${editionProviders.credentials.managedPath('root')}`,
        provider: channel.provider,
        forceBearerAuth: true,
      },
    }
  }

  try {
    if (channel.provider === 'openai-codex') {
      const credentials = await resolveCodexOAuthCredentials(channel.id)
      return {
        ok: true,
        credentials: {
          apiKey: credentials.access,
          baseUrl,
          provider: channel.provider,
          forceBearerAuth: false,
          codexOAuthCredentials: credentials,
        },
      }
    }
    const decryptedSecret = decryptApiKey(channel.id)
    if (channel.provider === 'xai') {
      const credentialMode = resolveXaiCredentialMode(channel.credentialMode, decryptedSecret)
      if (credentialMode === 'oauth') {
        const credentials = await resolveXaiOAuthCredentials(channel.id)
        return {
          ok: true,
          credentials: {
            apiKey: credentials.access,
            baseUrl,
            provider: channel.provider,
            forceBearerAuth: false,
            xaiCredentialMode: credentialMode,
            xaiOAuthCredentials: credentials,
          },
        }
      }
      return {
        ok: true,
        credentials: {
          apiKey: decryptedSecret,
          baseUrl,
          provider: channel.provider,
          forceBearerAuth: false,
          xaiCredentialMode: credentialMode,
          xaiApiProtocol: channel.apiProtocol,
        },
      }
    }
    return {
      ok: true,
      credentials: {
        apiKey: decryptedSecret,
        baseUrl,
        provider: channel.provider,
        forceBearerAuth: false,
      },
    }
  } catch {
    return { ok: false, code: 'api_key_decrypt_failed' }
  }
}

/** 普通轮次和 Relay 恢复共用凭据接线，刷新仍由 channel-manager 的已有回调持久化。 */
export function buildPiRuntimeCredentialOptions(
  channelId: string,
  credentials: ResolvedRuntimeCredentials,
): Pick<PiAgentQueryOptions, 'apiKey' | 'baseUrl' | 'provider' | 'codexOAuthCredentials' | 'onCodexOAuthCredentialsRefreshed' | 'xaiCredentialMode' | 'xaiApiProtocol' | 'xaiOAuthCredentials' | 'onXaiOAuthCredentialsRefreshed'> {
  return {
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    provider: credentials.provider,
    codexOAuthCredentials: credentials.codexOAuthCredentials,
    onCodexOAuthCredentialsRefreshed: credentials.codexOAuthCredentials
      ? (refreshed) => persistCodexOAuthCredentials(channelId, refreshed)
      : undefined,
    xaiCredentialMode: credentials.xaiCredentialMode,
    xaiApiProtocol: credentials.xaiApiProtocol,
    xaiOAuthCredentials: credentials.xaiOAuthCredentials,
    onXaiOAuthCredentialsRefreshed: credentials.xaiOAuthCredentials
      ? (refreshed) => persistXaiOAuthCredentials(channelId, refreshed)
      : undefined,
  }
}
