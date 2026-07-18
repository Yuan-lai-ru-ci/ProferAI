import type { ProviderType } from '@profer/shared'
import { getProferUserAgent } from '@profer/core'
import pkg from '../../../package.json' with { type: 'json' }

/** 这些 Anthropic-compatible 计划渠道要求 Bearer token 和固定 User-Agent。 */
export function usesAgentSdkBearerWithUserAgent(provider: ProviderType): boolean {
  return provider === 'kimi-coding'
    || provider === 'zhipu-coding'
    || provider === 'xiaomi-token-plan'
}

/** 仅将认证信息写入本次 SDK env，调用方不得改变主进程 process.env。 */
export function applyAgentSdkAuthEnv(
  target: Record<string, string | undefined>,
  provider: ProviderType,
  apiKey: string,
  forceBearerAuth = false,
): void {
  if (forceBearerAuth || usesAgentSdkBearerWithUserAgent(provider)) {
    target.ANTHROPIC_AUTH_TOKEN = apiKey
    if (usesAgentSdkBearerWithUserAgent(provider)) {
      target.ANTHROPIC_CUSTOM_HEADERS = `User-Agent: ${getProferUserAgent(pkg.version)}`
    }
    return
  }

  if (provider === 'minimax') {
    target.ANTHROPIC_AUTH_TOKEN = apiKey
    target.API_TIMEOUT_MS = '3000000'
    target.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    return
  }

  target.ANTHROPIC_API_KEY = apiKey
}
