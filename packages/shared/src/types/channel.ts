/**
 * 渠道（Channel）相关类型定义
 *
 * 渠道是用户配置的 AI 供应商连接，包含 API Key、模型列表等信息。
 * API Key 使用 Electron safeStorage 加密后存储在本地配置文件中。
 */

/**
 * 支持的 AI 供应商类型
 */
export type XaiCredentialMode = 'api-key' | 'oauth'

export type ProviderType =
  | 'anthropic'
  | 'anthropic-compatible'
  | 'openai'
  | 'openai-responses'
  | 'deepseek'
  | 'google'
  | 'kimi-api'
  | 'kimi-coding'
  | 'opencode-go-openai'
  | 'zhipu'
  | 'zhipu-coding'
  | 'zhipu-coding-team'
  | 'ark-coding-plan'
  | 'minimax'
  | 'doubao'
  | 'qwen'
  | 'qwen-anthropic'
  | 'xiaomi'
  | 'xiaomi-token-plan'
  | 'openai-codex'
  | 'xai'
  | 'ollama'
  | 'custom'

/**
 * 各供应商的默认 Base URL
 */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': '',
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com',
  'kimi-api': 'https://api.moonshot.cn/anthropic',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  'opencode-go-openai': 'https://opencode.ai/zen/go/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  'zhipu-coding': 'https://open.bigmodel.cn/api/anthropic',
  'zhipu-coding-team': 'https://open.bigmodel.cn/api/anthropic',
  'ark-coding-plan': 'https://ark.cn-beijing.volces.com/api/plan',
  minimax: 'https://api.minimaxi.com/anthropic',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-anthropic': 'https://dashscope.aliyuncs.com/apps/anthropic',
  xiaomi: 'https://api.xiaomimimo.com/anthropic',
  'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/anthropic',
  'openai-codex': '',
  xai: 'https://api.x.ai/v1',
  ollama: 'http://127.0.0.1:11434',
  custom: ''
}

/**
 * Agent 模式使用的 Anthropic 兼容 Base URL。
 *
 * `PROVIDER_DEFAULT_URLS` 永远表示 Chat / 模型列表使用的 Base URL，
 * 这里单独维护 Agent SDK 入口，避免 DeepSeek 这类双协议供应商混用端点。
 */
export const PROVIDER_DEFAULT_AGENT_URLS: Partial<Record<ProviderType, string>> = {
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/anthropic',
  'kimi-api': 'https://api.moonshot.cn/anthropic',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  'zhipu-coding': 'https://open.bigmodel.cn/api/anthropic',
  minimax: 'https://api.minimaxi.com/anthropic',
  xiaomi: 'https://api.xiaomimimo.com/anthropic',
  'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/anthropic',
  ollama: 'http://127.0.0.1:11434',
}

/**
 * 供应商显示名称
 */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容格式',
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses 格式',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kimi-api': 'Kimi API (Anthropic 协议)',
  'kimi-coding': 'Kimi Coding Plan',
  'opencode-go-openai': 'OpenCode Go (OpenAI 协议)',
  zhipu: '智谱 AI',
  'zhipu-coding': '智谱 Coding Plan',
  'zhipu-coding-team': '智谱 Coding Plan 团队版',
  'ark-coding-plan': '火山方舟 Coding Plan',
  minimax: 'MiniMax (API&编程包)',
  doubao: '豆包',
  qwen: '通义千问',
  'qwen-anthropic': '通义千问 (Anthropic 协议)',
  xiaomi: '小米 MiMo (API)',
  'xiaomi-token-plan': '小米 MiMo Token Plan',
  'openai-codex': 'ChatGPT 订阅 (Codex)',
  xai: 'xAI / Grok',
  ollama: 'Ollama 本地模型',
  custom: 'OpenAI 兼容格式',
}

/**
 * 支持 Agent 模式的供应商类型
 *
 * Agent SDK 通过 Anthropic 兼容协议调用 `/v1/messages` 端点，
 * 因此所有 Anthropic 协议兼容的供应商都可以用于 Agent。
 */
export const AGENT_COMPATIBLE_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'ollama',
])

/**
 * 判断供应商是否兼容 Agent 模式
 */
export function isAgentCompatibleProvider(provider: ProviderType): boolean {
  return AGENT_COMPATIBLE_PROVIDERS.has(provider)
}

/** Agent 内核标识。 */
export type AgentRuntimeMode = 'pi' | 'claude'

/**
 * 按现有 provider 规则推导渠支持的内核集合（老配置静默迁移用）。
 *
 * 必须与迁移前的行为等价，否则升级会翻车：
 * - Pi 能用任何启用渠道（历史上 Pi 渠道不受白名单限制）。
 * - Claude 仅能走 Anthropic 协议，沿用历史白名单；xAI 无 Anthropic 端点，
 *   且编排层本身就拒绝 xAI + Claude，因此不给它 claude。
 * - xAI 的 Pi 需要「启用实验性 Agent」开关。
 */
export function inferAgentRuntimeModes(
  channel: Pick<Channel, 'provider' | 'agentExperimentalEnabled'>,
): AgentRuntimeMode[] {
  if (channel.provider === 'xai') {
    return channel.agentExperimentalEnabled === true ? ['pi'] : []
  }
  return isAgentCompatibleProvider(channel.provider) ? ['pi', 'claude'] : ['pi']
}

/**
 * 该渠道在指定 Agent 内核下是否可用。
 *
 * 勾选优先；缺失时回退到 provider 推导，保证未迁移的老配置行为不变。
 */
/** Chat 不接受仅供 Pi 的订阅凭据；历史 xAI OAuth 标识由主进程读取时补齐。 */
export function isChannelEnabledForChat(
  channel: Pick<Channel, 'provider' | 'enabled' | 'credentialMode'>,
): boolean {
  return channel.enabled && channel.provider !== 'openai-codex'
    && !(channel.provider === 'xai' && channel.credentialMode === 'oauth')
}

export function isChannelEnabledForRuntime(
  channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'>,
  runtime: AgentRuntimeMode,
): boolean {
  if (!channel.enabled) return false
  const modes = channel.agentRuntimes ?? inferAgentRuntimeModes(channel)
  // 原生订阅/xAI adapter 只有 Pi 实现，手工勾选不能创造 Claude 协议。
  if ((channel.provider === 'xai' || channel.provider === 'openai-codex') && runtime === 'claude') return false
  // 显式内核优先；实验开关仅用于旧配置推导，UI 修改时同步两份字段。
  return modes.includes(runtime)
}

/** 解析 xAI 渠道的认证模式；历史渠道按密文内容兼容识别。 */
export function resolveXaiCredentialMode(mode: XaiCredentialMode | undefined, secret: string): XaiCredentialMode {
  // 结构化 OAuth 凭据优先，避免坏配置把 refresh token 当作 API Key 发到 Chat。
  if (parseXaiCredentials(secret)) return 'oauth'
  return mode === 'oauth' ? 'oauth' : 'api-key'
}

/** xAI API Key 模式可使用 Pi 原生 provider；订阅 OAuth 仅在显式实验开关开启时进入 Agent。 */
/** @deprecated 语义上等价于「该渠道是否勾选了 Claude 内核」，保留供旧调用方使用。 */
export function isAgentEnabledForChannel(
  channel: Pick<Channel, 'provider' | 'enabled' | 'agentExperimentalEnabled' | 'agentRuntimes'>,
): boolean {
  return isChannelEnabledForRuntime(channel, 'claude')
}


export interface ZhipuTeamCredentials {
  apiKey: string
  organization?: string
  project?: string
}

function normalizeZhipuCredentialKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_-]/g, '')
}

/** Parse the structured secret used by the Zhipu Coding Plan team channel. */
export function parseZhipuTeamCredentials(secret: string): ZhipuTeamCredentials | null {
  const trimmed = secret.trim()
  if (!trimmed) return null
  const pick = (record: Record<string, unknown>): ZhipuTeamCredentials | null => {
    const normalized = new Map<string, string>()
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && value.trim()) normalized.set(normalizeZhipuCredentialKey(key), value.trim())
    }
    const apiKey = normalized.get('apikey') ?? normalized.get('apitoken') ?? normalized.get('token')
      ?? normalized.get('authorization') ?? normalized.get('auth') ?? normalized.get('bearer')
    if (!apiKey) return null
    return { apiKey, organization: normalized.get('bigmodelorganization') ?? normalized.get('organization') ?? normalized.get('org'), project: normalized.get('bigmodelproject') ?? normalized.get('project') }
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return pick(parsed as Record<string, unknown>)
    } catch { return null }
  }
  const entries: Record<string, string> = {}
  for (const part of trimmed.split(/[;\n]+/)) {
    const index = part.indexOf('=')
    if (index > 0) entries[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return pick(entries)
}

export function extractZhipuCodingTeamApiToken(secret: string): string {
  const token = parseZhipuTeamCredentials(secret)?.apiKey
  return token || secret.trim() || secret
}

/** OAuth credentials stored (encrypted) in Channel.apiKey for the Pi Codex provider. */
export interface CodexOAuthCredentials {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

export function serializeCodexCredentials(credentials: CodexOAuthCredentials): string {
  return JSON.stringify(credentials)
}

export function parseCodexCredentials(secret: string): CodexOAuthCredentials | null {
  const trimmed = secret.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<CodexOAuthCredentials>
    if (typeof parsed.access === 'string' && parsed.access
      && typeof parsed.refresh === 'string' && parsed.refresh
      && typeof parsed.expires === 'number') {
      return {
        access: parsed.access,
        refresh: parsed.refresh,
        expires: parsed.expires,
        ...(typeof parsed.accountId === 'string' && parsed.accountId ? { accountId: parsed.accountId } : {}),
      }
    }
  } catch {
    return null
  }
  return null
}

export function isCodexCredentialExpired(credentials: CodexOAuthCredentials, skewMs = 60_000): boolean {
  return Date.now() >= credentials.expires - skewMs
}

/**
 * xAI（Grok/X 订阅）OAuth 凭据。
 *
 * 与 Codex 一样序列化后放入 Channel.apiKey，并由 Electron safeStorage 加密。
 * Pi 的内置 xAI provider 使用 access / refresh / expires 来自动续期。
 */
export interface XaiOAuthCredentials {
  access: string
  refresh: string
  expires: number
}

export function serializeXaiCredentials(credentials: XaiOAuthCredentials): string {
  return JSON.stringify(credentials)
}

export function parseXaiCredentials(secret: string): XaiOAuthCredentials | null {
  const trimmed = secret.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<XaiOAuthCredentials>
    if (typeof parsed.access === 'string' && parsed.access
      && typeof parsed.refresh === 'string' && parsed.refresh
      && typeof parsed.expires === 'number') {
      return { access: parsed.access, refresh: parsed.refresh, expires: parsed.expires }
    }
  } catch {
    return null
  }
  return null
}

export function isXaiCredentialExpired(credentials: XaiOAuthCredentials, skewMs = 60_000): boolean {
  return Date.now() >= credentials.expires - skewMs
}

/** xAI device-code 授权信息（用于浏览器未预填时手动填写）。 */
export interface XaiOAuthDeviceCode {
  userCode: string
  verificationUri: string
  /** 可扫码交给另一台可联网设备完成授权。 */
  qrCodeData?: string
}

/**
 * 渠道中的模型配置
 */
export interface ChannelModel {
  /** 模型唯一标识（如 claude-sonnet-4-5-20250929） */
  id: string
  /** 模型显示名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /**
   * 1M 上下文偏好（三态，由渠道配置里的「1M」勾选控制）：
   * - 缺省：按模型 + provider 白名单自动判定（历史行为）
   * - true：强制开启（未验证的第三方网关也允许，能否真协商由端点决定）
   * - false：强制关闭（即使模型 / 渠道验证支持也不按 1M 处理）
   */
  context1m?: boolean
  /** 来源标记：手动添加的模型在拉取供应商列表时保留，不会被覆盖清除 */
  source?: 'manual' | 'fetched'
  /** 服务端代管模式下，当前登录用户实际可见的模型倍率。 */
  multiplier?: number
}

/**
 * 渠道配置
 *
 * 存储在 ~/.proma/channels.json 中，apiKey 字段为加密后的 base64 字符串
 */
export interface Channel {
  /** 渠道唯一标识 */
  id: string
  /** 渠道名称（用户自定义） */
  name: string
  /** AI 供应商类型 */
  provider: ProviderType
  /** API Base URL（Chat 模式 / OpenAI 兼容端点） */
  baseUrl: string
  /** xAI 认证模式；缺失时兼容识别历史 OAuth 渠道。 */
  credentialMode?: XaiCredentialMode
  /** xAI Agent 实验开关；仅对 xAI 渠道生效，默认关闭。 */
  agentExperimentalEnabled?: boolean
  /** Agent 模式 Anthropic 兼容端点（为空则自动推导） */
  agentBaseUrl?: string
  /**
   * 该渠道允许用于哪些 Agent 内核，由用户在配置页勾选。
   *
   * 目的是取消「按渠道类型推断能不能用」的门禁：能不能用由用户填写的地址与勾选决定。
   * 缺失（undefined）表示尚未迁移的老配置，读取时按 provider 规则推导后静默写回。
   */
  agentRuntimes?: AgentRuntimeMode[]
  /** 加密后的 API Key（base64 编码） */
  apiKey: string
  /** 可用模型列表 */
  models: ChannelModel[]
  /** 是否启用 */
  enabled: boolean
  /** 是否由服务端统一管理（商业模式下从 /v1/account/channels 同步的渠道）。服务端删除后本地自动清理 */
  serverManaged?: boolean
  /** 官方渠道是否直接请求 New API 数据面；false 时通过 Team Server Relay。 */
  directDataPlane?: boolean
  /** 服务端管理渠道的语义类型；model-family 表示按模型族汇流的官方模型池。 */
  managedType?: 'model-family' | 'legacy'
  /** 模型族模型池的稳定标识，仅由服务端目录提供。 */
  familyId?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * 创建渠道时的输入数据（apiKey 为明文）
 */
export interface ChannelCreateInput {
  name: string
  provider: ProviderType
  baseUrl: string
  credentialMode?: XaiCredentialMode
  agentExperimentalEnabled?: boolean
  agentBaseUrl?: string
  /** 该渠道允许用于哪些 Agent 内核；不传则按 provider 规则推导。 */
  agentRuntimes?: AgentRuntimeMode[]
  /** 明文 API Key，主进程会加密后存储 */
  apiKey: string
  models: ChannelModel[]
  enabled: boolean
}

/**
 * 更新渠道时的输入数据（所有字段可选）
 */
export interface ChannelUpdateInput {
  name?: string
  provider?: ProviderType
  baseUrl?: string
  credentialMode?: XaiCredentialMode
  agentExperimentalEnabled?: boolean
  agentBaseUrl?: string
  /** 该渠道允许用于哪些 Agent 内核。 */
  agentRuntimes?: AgentRuntimeMode[]
  /** 明文 API Key，为空字符串表示不更新 */
  apiKey?: string
  models?: ChannelModel[]
  enabled?: boolean
}

/**
 * 渠道配置文件格式
 */
export interface ChannelsConfig {
  /** 配置版本号 */
  version: number
  /** 渠道列表 */
  channels: Channel[]
  /** 已执行的一次性预设模型更新，避免重复追加用户主动移除的候选模型。 */
  appliedPresetModelUpdates?: string[]
}

/**
 * 连接测试结果
 */
export interface ChannelTestResult {
  /** 请求主动取消；不作为供应商故障展示。 */
  cancelled?: boolean
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
}

/** 官方模型最近请求的单次可用性采样。 */
export interface ModelAvailabilitySample {
  status: 'success' | 'degraded' | 'failure'
  durationMs: number
  createdAt: number
}

/** 官方模型最近请求的可用性摘要。 */
export interface ModelAvailability {
  modelId: string
  availability: number | null
  sampleCount: number
  avgLatencyMs: number | null
  updatedAt: number | null
  samples: ModelAvailabilitySample[]
}

/** 官方渠道下的模型可用性数据。 */
export interface OfficialChannelHealth {
  channelId: string
  models: ModelAvailability[]
  updatedAt: number | null
}

/**
 * 拉取模型的输入参数（无需已保存的渠道，直接传入凭证）
 */
export interface FetchModelsInput {
  /** 可选请求标识；取消仅作用于发起该请求的窗口。 */
  requestId?: string
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key */
  apiKey: string
  /** 连接测试可选：验证指定模型生成；未指定时仅检查模型目录。 */
  modelId?: string
  /** 连接测试可选：Claude 使用独立 Anthropic 端点，Pi 使用渠道原生协议。 */
  runtime?: AgentRuntimeMode
  /** 连接测试可选：独立 Claude 端点；模型发现仍使用 baseUrl。 */
  agentBaseUrl?: string
}

/**
 * 拉取模型的结果
 */
export interface FetchModelsResult {
  /** 请求主动取消；取消时不返回部分模型目录。 */
  cancelled?: boolean
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
  /** 获取到的模型列表 */
  models: ChannelModel[]
}

/** xAI 已有渠道重新授权，或授权成功后创建新渠道。 */
export type XaiOAuthLoginInput = string | Omit<ChannelCreateInput, 'apiKey' | 'provider' | 'credentialMode'>

/** 已有渠道重新授权，或授权成功后才创建新渠道；不从 Renderer 接收 OAuth 凭据。 */
export type CodexOAuthLoginInput = string | Omit<ChannelCreateInput, 'apiKey' | 'provider'>

/**
 * 渠道相关 IPC 通道常量
 */
export const CHANNEL_IPC_CHANNELS = {
  /** 获取所有渠道列表 */
  LIST: 'channel:list',
  /** 获取官方模型最近可用性 */
  GET_OFFICIAL_HEALTH: 'channel:get-official-health',
  /** 创建渠道 */
  CREATE: 'channel:create',
  /** 更新渠道 */
  UPDATE: 'channel:update',
  /** 删除渠道 */
  DELETE: 'channel:delete',
  /** 解密获取明文 API Key */
  DECRYPT_KEY: 'channel:decrypt-key',
  /** 测试渠道连接 */
  TEST: 'channel:test',
  /** 从供应商拉取可用模型列表 */
  FETCH_MODELS: 'channel:fetch-models',
  /** 直接测试连接（无需已保存渠道，传入明文凭证） */
  TEST_DIRECT: 'channel:test-direct',
  /** 从服务端同步渠道 */
  SYNC_FROM_SERVER: 'channel:sync-from-server',
  /** ChatGPT Codex 登录成功后才创建或更新渠道。 */
  CODEX_LOGIN: 'channel:codex-login',
  /** 按当前窗口与 requestId 取消测试/发现，不影响其它请求。 */
  CANCEL_REQUEST: 'channel:cancel-request',
  /** 取消当前进行中的 ChatGPT Codex OAuth 登录。 */
  CODEX_LOGIN_CANCEL: 'channel:codex-login-cancel',
  /** 获取 Pi 当前内置的 ChatGPT Codex 模型目录。 */
  CODEX_MODELS: 'channel:codex-models',
  /** 检查是否处于商业模式 */
  GET_COMMERCIAL_MODE: 'channel:get-commercial-mode',
  /** 获取构建目标（oss/commercial） */
  GET_BUILD_TARGET: 'channel:get-build-target',
  /** xAI 授权成功后创建或更新渠道，由主进程加密保存。 */
  XAI_LOGIN: 'channel:xai-login',
  /** 获取账号能力（商业模式+自配权限+账号类型） */
  /** 取消当前 xAI 订阅授权。 */
  XAI_LOGIN_CANCEL: 'channel:xai-login-cancel',
  /** Pi 内置 xAI 目录，订阅模型可用性仍取决于账号。 */
  XAI_MODELS: 'channel:xai-models',
  GET_ACCOUNT_CAPABILITIES: 'channel:get-account-capabilities',
  /** 查询订阅 Plan 额度 */
  GET_PLAN_QUOTA: 'channel:get-plan-quota',
} as const

/**
 * 订阅 Plan 的窗口型额度。
 *
 * 用于展示类似「每 5 小时」和「每周」这类限频窗口的剩余比例。
 */
export interface ChannelPlanQuotaWindow {
  /** 窗口类型标识 */
  type: '5h' | 'weekly' | 'custom'
  /** 展示标签 */
  label: string
  /** 剩余额度百分比，0-100 */
  remainingPercent: number
  /** 已使用百分比，0-100 */
  usedPercent: number
  /** 覆盖展示值。用于余额等无法自然转成百分比的额度。 */
  remainingLabel?: string
  /** 是否展示进度条。默认展示。 */
  showProgress?: boolean
  /** 重置时间戳（毫秒） */
  resetAt?: number
}

/**
 * 渠道订阅 Plan 额度查询结果。
 */
export interface ChannelPlanQuotaResult {
  /** 当前渠道是否支持订阅额度查询 */
  supported: boolean
  /** 渠道供应商类型 */
  provider: ProviderType
  /** Plan 展示名称 */
  planName?: string
  /** 查询到的窗口额度列表 */
  windows: ChannelPlanQuotaWindow[]
  /** 查询时间戳（毫秒） */
  updatedAt: number
  /** 渠道更新时间戳（毫秒），用于 renderer 侧缓存 key 校验渠道是否变更 */
  channelUpdatedAt?: number
  /** 不支持或查询失败时的用户可读原因 */
  message?: string
}
