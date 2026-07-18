import { isAbsolute, relative, resolve } from 'node:path'
import type { ProviderType } from '@profer/shared'
import { normalizeAnthropicBaseUrlForSdk, getProferUserAgent } from '@profer/core'
import pkg from '../../../package.json' with { type: 'json' }

/** 在任意 await 前原子占用会话；false 表示已有同 session 运行。 */
export function tryAcquireActiveSession(activeSessions: Map<string, string>, sessionId: string, runToken: string): boolean {
  if (activeSessions.has(sessionId)) return false
  activeSessions.set(sessionId, runToken)
  return true
}

/** 仅持有当前 token 的运行可以释放会话，避免旧 finally 清掉新运行。 */
export function releaseActiveSession(activeSessions: Map<string, string>, sessionId: string, runToken: string): boolean {
  if (activeSessions.get(sessionId) !== runToken) return false
  activeSessions.delete(sessionId)
  return true
}

/** Plan 模式只允许写入当前会话 .context/plan 内的 Markdown 文件。 */
export function isPlanModeMarkdownPath(agentCwd: string, filePath: string): boolean {
  const planDir = resolve(agentCwd, '.context', 'plan')
  const targetPath = resolve(agentCwd, filePath)
  const relativePath = relative(planDir, targetPath)
  const isWithinPlanDir = relativePath !== ''
    && !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  return filePath.toLowerCase().endsWith('.md') && isWithinPlanDir
}

/**
 * 仅向本轮 query env 写入凭证，绝不改动 process.env。
 * 调用方负责先准备好从 process.env 过滤过的基础环境。
 */
export function applySdkCredentials(
  sdkEnv: Record<string, string | undefined>,
  apiKey: string,
  baseUrl: string | undefined,
  provider: ProviderType,
  forceBearerAuth = false,
): void {
  if (forceBearerAuth) {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = apiKey
  } else if (provider === 'kimi-coding' || provider === 'zhipu-coding' || provider === 'xiaomi-token-plan') {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = apiKey
    sdkEnv.ANTHROPIC_CUSTOM_HEADERS = `User-Agent: ${getProferUserAgent(pkg.version)}`
  } else if (provider === 'minimax') {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = apiKey
    sdkEnv.API_TIMEOUT_MS = '3000000'
    sdkEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  } else {
    sdkEnv.ANTHROPIC_API_KEY = apiKey
  }
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') {
    sdkEnv.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrlForSdk(baseUrl)
  }
}

/** MCP 名称在 Plan 模式下无法可靠判定只读性，必须拒绝。 */
export function isPlanModeMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}
