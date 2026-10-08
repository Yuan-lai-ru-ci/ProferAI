import type { AgentRuntime, Channel, CodexOAuthCredentials, ProviderType, XaiOAuthCredentials } from '@profer/shared'
import { PROVIDER_DEFAULT_URLS, resolveXaiCredentialMode } from '@profer/shared'
import { getTeamAuthWithRefresh } from './auth-service'
import { decryptApiKey, isCommercialMode, persistCodexOAuthCredentials, persistXaiOAuthCredentials, resolveChannelAgentBaseUrl, resolveCodexOAuthCredentials, resolveXaiOAuthCredentials } from './channel-manager'
import { isCommercialBuild } from './build-target'
import { isOfficialManagedChannel } from './official-channel'
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
}

export type ResolveRuntimeCredentialsResult =
  | { ok: true; credentials: ResolvedRuntimeCredentials }
  | { ok: false; code: 'token_expired' | 'api_key_decrypt_failed' }

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
  channel: Pick<Channel, 'id' | 'provider' | 'baseUrl' | 'agentBaseUrl' | 'credentialMode' | 'directDataPlane'>,
  runtime: AgentRuntime = 'claude',
): Promise<ResolveRuntimeCredentialsResult> {
  const isOfficialChannel = isOfficialManagedChannel(channel)
  const forceBearerAuth = (isCommercialBuild() || isCommercialMode()) && isOfficialChannel

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
): Pick<PiAgentQueryOptions, 'apiKey' | 'baseUrl' | 'provider' | 'codexOAuthCredentials' | 'onCodexOAuthCredentialsRefreshed' | 'xaiCredentialMode' | 'xaiOAuthCredentials' | 'onXaiOAuthCredentialsRefreshed'> {
  return {
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    provider: credentials.provider,
    codexOAuthCredentials: credentials.codexOAuthCredentials,
    onCodexOAuthCredentialsRefreshed: credentials.codexOAuthCredentials
      ? (refreshed) => persistCodexOAuthCredentials(channelId, refreshed)
      : undefined,
    xaiCredentialMode: credentials.xaiCredentialMode,
    xaiOAuthCredentials: credentials.xaiOAuthCredentials,
    onXaiOAuthCredentialsRefreshed: credentials.xaiOAuthCredentials
      ? (refreshed) => persistXaiOAuthCredentials(channelId, refreshed)
      : undefined,
  }
}
