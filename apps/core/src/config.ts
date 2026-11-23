import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProviderType } from '@profer/shared'

export const DEFAULT_CORE_HOST = '127.0.0.1'
export const DEFAULT_CORE_PORT = 7788

export interface CoreChannelConfig {
  id: string
  name: string
  provider: ProviderType
  apiKey: string
  forceBearerAuth?: boolean
  serverManaged?: boolean
  directDataPlane?: boolean
  baseUrl?: string
  agentBaseUrl?: string
  credentialMode?: 'api-key' | 'oauth'
  apiProtocol?: 'responses' | 'chat-completions'
  codexOAuthCredentials?: Record<string, unknown>
  xaiOAuthCredentials?: Record<string, unknown>
  agentExperimentalEnabled?: boolean
  models?: Array<{ id: string; name: string; enabled: boolean; context1m?: boolean; source?: 'manual' | 'fetched' | 'builtin-catalog' }>
  enabled?: boolean
  agentRuntimes?: Array<'claude' | 'pi'>
}

export interface CoreConfig {
  /** 仅可编程注入的隔离测试服务器；不从环境或CLI读取。 */
  accountServerUrl?: string
  host: string
  port: number
  configDir: string
  workspaceRoot: string
  /** 桌面宿主显式指定的 v4 工作区索引；未启用 writable 时Core只读。 */
  desktopWorkspaceIndexPath?: string
  /** 仅本机随桌面启动的Core可成为桌面v4索引写者。 */
  desktopWorkspaceIndexWritable?: boolean
  /** 桌面停止旧调度后传入原IANA时区；显式启用旧Automation交接。 */
  desktopAutomationTimeZone?: string
  apiKey?: string
  coreId?: string
  channels?: CoreChannelConfig[]
  /** Core所属网页搜索凭据与启用状态；密钥也可独立保存在 configDir/web-search.json。 */
  webSearch?: { apiKey?: string; enabled?: boolean }
  browser?: { executablePath?: string }
  /** 临时调试开关：挂载 /debug/* 路由。 */
  debug?: boolean
  /** 临时调试开关：用合成回复替代真实模型调用。 */
  mockAgent?: boolean
}

export interface CoreConfigInput {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

function parseListen(value: string, independent: boolean): Pick<CoreConfig, 'host' | 'port'> {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('listen address cannot be empty')

  const separator = trimmed.lastIndexOf(':')
  const host = separator > 0 ? trimmed.slice(0, separator) : DEFAULT_CORE_HOST
  const portText = separator > 0 ? trimmed.slice(separator + 1) : trimmed
  const port = Number(portText)

  if (!Number.isInteger(port) || port < (independent && host === '127.0.0.1' ? 0 : 1) || port > 65535) {
    throw new Error(`invalid listen port: ${portText}`)
  }
  if (!host || host.includes('/') || host.includes(' ')) {
    throw new Error(`invalid listen host: ${host}`)
  }

  return { host, port }
}

const providerNames = new Set<ProviderType>([
  'anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'deepseek', 'google',
  'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team',
  'ark-coding-plan', 'minimax', 'doubao', 'qwen', 'qwen-anthropic', 'xiaomi', 'xiaomi-token-plan',
  'openai-codex', 'xai', 'ollama', 'custom',
])

function parseChannels(env: NodeJS.ProcessEnv): CoreChannelConfig[] {
  const raw = env.PROFER_CORE_CHANNELS_JSON
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`invalid PROFER_CORE_CHANNELS_JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(parsed)) throw new Error('PROFER_CORE_CHANNELS_JSON must be an array')
    return parsed.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`channel ${index} must be an object`)
      const value = item as Record<string, unknown>
      const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `core-channel-${index + 1}`
      const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id
      const provider = value.provider
      const apiKey = typeof value.apiKey === 'string' ? value.apiKey : ''
      if (typeof provider !== 'string' || !providerNames.has(provider as ProviderType)) throw new Error(`channel ${id} has an unsupported provider`)
      return {
        id,
        name,
        provider: provider as ProviderType,
        apiKey,
        ...(value.models && Array.isArray(value.models) ? { models: value.models.filter((model): model is { id: string; name: string; enabled: boolean; context1m?: boolean } => Boolean(model && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.enabled === 'boolean')) } : {}),
        ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
        ...(Array.isArray(value.agentRuntimes) ? { agentRuntimes: value.agentRuntimes.filter((runtime): runtime is 'claude' | 'pi' => runtime === 'claude' || runtime === 'pi') } : {}),
        ...(typeof value.baseUrl === 'string' && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
        ...(typeof value.agentBaseUrl === 'string' && value.agentBaseUrl ? { agentBaseUrl: value.agentBaseUrl } : {}),
        ...(value.credentialMode === 'api-key' || value.credentialMode === 'oauth' ? { credentialMode: value.credentialMode } : {}),
        ...(value.apiProtocol === 'responses' || value.apiProtocol === 'chat-completions' ? { apiProtocol: value.apiProtocol } : {}),
        ...(typeof value.agentExperimentalEnabled === 'boolean' ? { agentExperimentalEnabled: value.agentExperimentalEnabled } : {}),
        ...(value.codexOAuthCredentials && typeof value.codexOAuthCredentials === 'object' ? { codexOAuthCredentials: value.codexOAuthCredentials as Record<string, unknown> } : {}),
        ...(value.xaiOAuthCredentials && typeof value.xaiOAuthCredentials === 'object' ? { xaiOAuthCredentials: value.xaiOAuthCredentials as Record<string, unknown> } : {}),
      }
    })
  }

  const apiKey = env.PROFER_PI_API_KEY ?? env.PROFER_ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey) return []
  const provider = (env.PROFER_PI_PROVIDER ?? env.PROFER_ANTHROPIC_PROVIDER ?? 'anthropic') as ProviderType
  if (!providerNames.has(provider)) throw new Error(`unsupported provider: ${provider}`)
  return [{
    id: env.PROFER_PI_CHANNEL_ID ?? 'core-environment',
    name: env.PROFER_PI_CHANNEL_NAME ?? 'Core environment',
    provider,
    apiKey,
    ...(env.PROFER_PI_BASE_URL || env.ANTHROPIC_BASE_URL ? { baseUrl: env.PROFER_PI_BASE_URL ?? env.ANTHROPIC_BASE_URL } : {}),
    ...(env.PROFER_PI_AGENT_BASE_URL ? { agentBaseUrl: env.PROFER_PI_AGENT_BASE_URL } : {}),
  }]
}

export function parseCoreConfig(input: CoreConfigInput = {}): CoreConfig {
  const argv = input.argv ?? process.argv.slice(2)
  const env = input.env ?? process.env
  const independent = argv.includes('--desktop-independent')
  const listen = readFlag(argv, 'listen') ?? env.PROFER_CORE_LISTEN ?? `${DEFAULT_CORE_HOST}:${independent ? 0 : DEFAULT_CORE_PORT}`
  const configDir = readFlag(argv, 'config-dir') ?? env.PROFER_CONFIG_DIR ?? join(input.homeDir ?? homedir(), '.profer')
  const workspaceRoot = env.PROFER_CORE_WORKSPACE_ROOT ?? join(configDir, 'workspaces')
  const parsedListen = parseListen(listen, independent)
  const channels = parseChannels(env)

  return {
    ...parsedListen,
    configDir: resolve(configDir),
    workspaceRoot: resolve(workspaceRoot),
    ...(env.PROFER_CORE_DESKTOP_WORKSPACE_INDEX?.trim() ? { desktopWorkspaceIndexPath: resolve(env.PROFER_CORE_DESKTOP_WORKSPACE_INDEX.trim()) } : {}),
    ...(env.PROFER_CORE_DESKTOP_WORKSPACE_INDEX_WRITABLE === '1' ? { desktopWorkspaceIndexWritable: true } : {}),
    ...(env.PROFER_CORE_DESKTOP_AUTOMATION_TIME_ZONE ? { desktopAutomationTimeZone: env.PROFER_CORE_DESKTOP_AUTOMATION_TIME_ZONE } : {}),
    ...(env.PROFER_CORE_API_KEY ? { apiKey: env.PROFER_CORE_API_KEY } : {}),
    ...(env.PROFER_CORE_ID ? { coreId: env.PROFER_CORE_ID } : {}),
    ...(env.PROFER_CORE_BROWSER_EXECUTABLE ? { browser: { executablePath: env.PROFER_CORE_BROWSER_EXECUTABLE } } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    ...(env.PROFER_CORE_TAVILY_API_KEY || env.PROFER_CORE_WEB_SEARCH_ENABLED !== undefined ? {
      webSearch: {
        ...(env.PROFER_CORE_TAVILY_API_KEY ? { apiKey: env.PROFER_CORE_TAVILY_API_KEY } : {}),
        ...(env.PROFER_CORE_WEB_SEARCH_ENABLED !== undefined ? { enabled: env.PROFER_CORE_WEB_SEARCH_ENABLED === '1' || env.PROFER_CORE_WEB_SEARCH_ENABLED.toLowerCase() === 'true' } : {}),
      },
    } : {}),
    ...(env.PROFER_CORE_DEBUG === '1' || argv.includes('--debug') ? { debug: true } : {}),
    ...(env.PROFER_CORE_MOCK_AGENT === '1' || argv.includes('--mock-agent') ? { mockAgent: true } : {}),
  }
}
