import type { ProviderType } from '@profer/shared'
import { getWhitelistCompatUserAgent } from '@profer/core/providers'

/**
 * Claude Agent SDK 认证环境。
 *
 * 原实现位于 apps/electron/src/main/lib/agent-sdk-auth-env.ts，因为只服务 Claude Agent SDK
 * 的 env 形状（ANTHROPIC_* + CLAUDE_CODE_*）而随 provider 迁入本包；Electron 侧保留薄包装，
 * 显式传入应用版本以保持既有 User-Agent 行为逐字节一致。
 */

/** 这些 Anthropic-compatible 计划渠道要求 Bearer token 和固定 User-Agent（白名单登记的是旧产品名）。 */
export function usesAgentSdkBearerWithUserAgent(provider: ProviderType): boolean {
  return provider === 'kimi-coding'
    || provider === 'zhipu-coding'
    || provider === 'xiaomi-token-plan'
}

/**
 * 仅将认证信息写入本次 SDK env，调用方不得改变主进程 process.env。
 *
 * @param userAgentVersion 显式版本号；省略时使用宿主通过 setProferVersion 初始化的版本，
 *                         宿主未初始化时为 '0.0.0'。
 */
export function applyAgentSdkAuthEnv(
  target: Record<string, string | undefined>,
  provider: ProviderType,
  apiKey: string,
  forceBearerAuth = false,
  userAgentVersion?: string,
): void {
  if (provider === 'ollama') {
    target.ANTHROPIC_AUTH_TOKEN = apiKey || 'ollama'
    // Ollama 兼容层的普通文本流仍保持开启；仅关闭 Claude Code 将 tool
    // 参数拆成增量片段的 fine-grained tool streaming。Qwen3.8 + Ollama
    // 0.32/0.33 在 tool_result 续请求上存在已公开的流式解析问题。
    target.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '0'
    return
  }

  if (forceBearerAuth || usesAgentSdkBearerWithUserAgent(provider)) {
    target.ANTHROPIC_AUTH_TOKEN = apiKey
    if (usesAgentSdkBearerWithUserAgent(provider)) {
      target.ANTHROPIC_CUSTOM_HEADERS = `User-Agent: ${getWhitelistCompatUserAgent(userAgentVersion)}`
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
