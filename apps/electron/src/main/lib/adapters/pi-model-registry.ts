/**
 * Pi 模型注册与渠道兼容层。
 *
 * Pi SDK 需要把 Proma 渠道临时注册成 runtime provider；这里集中处理
 * ProviderType 到 Pi API 协议、baseUrl、认证头和模型 catalog 默认值的映射。
 */

import {
  ONE_MILLION_CONTEXT_WINDOW,
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  extractZhipuCodingTeamApiToken,
  isDeepSeekV4Model,
  resolveDeepSeekV4ModelId,
  supportsVerified1MContext,
  type CodexOAuthCredentials,
  type ProviderType,
  type XaiOAuthCredentials,
  inferReasoningTransport,
  type ReasoningTransport,
  resolveReasoningCapability,
  resolveReasoningProfile,
  type ReasoningCapability,
} from '@profer/shared'
import { getProferUserAgent, isAnthropicShapedEndpoint, normalizeAnthropicBaseUrlForSdk, normalizeOpenAIBaseUrlForSdk, resolveAnthropicMessagesUrl } from '@profer/core'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai/compat'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { refreshXaiOAuthCredentialsSerial, rememberXaiOAuthCredentials } from '../xai-oauth-credentials'
import { isOfficialManagedChannel } from '../official-channel'
import { createIsolatedModelRuntimeOptions } from '../pi-model-runtime-options'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type PiAiCompat = typeof import('@earendil-works/pi-ai/compat')
type PiCatalogModel = Model<Api>
type PiModelCost = PiCatalogModel['cost']
type PiRequestHeaders = Record<string, string>
type PiCatalogModelPatch = Pick<PiCatalogModel, 'id'> & Partial<PiCatalogModel>

interface PiModelDefaults {
  reasoning: boolean
  thinkingLevelMap?: PiCatalogModel['thinkingLevelMap']
  compat?: PiCatalogModel['compat']
  input: PiCatalogModel['input']
  cost: PiModelCost
  contextWindow: number
  maxTokens: number
}

const ZERO_MODEL_COST: PiModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}
export const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_MAX_TOKENS = 64_000
const VOLCENGINE_GLM_MAX_TOKENS = 128_000
const GLM_53_MAX_TOKENS = 131_072
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_MAX_TOKENS = 128_000
const CODEX_54_MINI_CONTEXT_WINDOW = CODEX_GPT_54_MINI_CONTEXT_WINDOW
const CODEX_56_CONTEXT_WINDOW = 1_050_000
const CODEX_THINKING_LEVEL_MAP = { xhigh: 'xhigh', minimal: 'low' } as const
const OFFICIAL_GPT_56_MODEL_IDS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
const GPT_6_ASTRA_MODEL_ID = 'gpt-6-astra'

/** Pi 内置 OpenAI/Codex catalog 当前把这三个已验证 SKU 误标为 272K。 */
function resolveVerifiedGpt56ContextWindow(modelId?: string): number | undefined {
  return modelId && OFFICIAL_GPT_56_MODEL_IDS.has(modelId.trim().toLowerCase())
    ? CODEX_56_CONTEXT_WINDOW
    : undefined
}

function applyVerifiedGpt56ContextWindow(model: PiCatalogModel): PiCatalogModel {
  const contextWindow = resolveVerifiedGpt56ContextWindow(model.id)
  return contextWindow != null && model.contextWindow !== contextWindow
    ? { ...model, contextWindow }
    : model
}

const CODEX_MODEL_PATCHES: PiCatalogModelPatch[] = [
  {
    id: GPT_6_ASTRA_MODEL_ID,
    name: 'GPT-6 Astra',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    // 0.86 起上游 openai-codex catalog 已移除 gpt-5.4：这里保留条目作为兜底，
    // 只有当 catalog 仍收录该 ID 时才会把它的窗口覆盖为当前规格（否则不凭空补回）。
    id: 'gpt-5.4',
    contextWindow: CODEX_56_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.4-mini',
    contextWindow: CODEX_54_MINI_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.5',
    contextWindow: CODEX_56_CONTEXT_WINDOW,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: CODEX_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: CODEX_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
    input: ['text', 'image'],
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: CODEX_56_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
  },
]

let piAiCompatPromise: Promise<PiAiCompat> | undefined

function loadPiAiCompat(): Promise<PiAiCompat> {
  piAiCompatPromise ??= import('@earendil-works/pi-ai/compat')
  return piAiCompatPromise
}

function toReasoningTransport(api: Api): ReasoningTransport {
  switch (api) {
    case 'anthropic-messages':
      return 'anthropic-messages'
    case 'openai-completions':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    default:
      return 'other'
  }
}

/** Compiles the shared model profile into Pi catalog compatibility metadata. */
function compilePiReasoningCapabilities(api: Api, modelId: string | undefined): Pick<PiModelDefaults, 'compat' | 'thinkingLevelMap'> | undefined {
  const transport = toReasoningTransport(api)
  const profile = resolveReasoningProfile({ modelId, transport })
  const encoding = profile?.encodings[transport]
  if (!encoding) return undefined

  const thinkingLevelMap = encoding.effortMap as PiCatalogModel['thinkingLevelMap']
  switch (encoding.kind) {
    case 'adaptive-effort':
      return { compat: { forceAdaptiveThinking: true }, thinkingLevelMap }
    case 'deepseek-output-effort':
    case 'anthropic-manual':
      return { thinkingLevelMap }
    case 'openai-reasoning-effort':
      return { compat: { supportsReasoningEffort: true }, thinkingLevelMap }
    case 'zai-thinking-effort':
      return {
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: 'zai',
          zaiToolStream: true,
        },
        thinkingLevelMap,
      }
    case 'zai-toggle':
      return {
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          thinkingFormat: 'zai',
          zaiToolStream: true,
        },
        thinkingLevelMap,
      }
  }
}

function isLocalOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** 商业代管 relay 的 Base：协议由服务端路由决定，不能按端点形态推断。 */
function isRelayProxyBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().replace(/\/+$/, '').endsWith('/v1/proxy')
}

/**
 * 解析 Pi 请求使用的协议。
 *
 * DeepSeek 同时提供 OpenAI 兼容与 Anthropic 兼容两套入口（官方另有 `/anthropic`）。
 * 协议必须跟随**配置的端点**，而不是写死 provider：第三方中转网关绝大多数只提供
 * OpenAI 兼容端点，若仍按 provider 判定为 Anthropic，Agent 会向它发送
 * `/v1/messages` 而完全不可用——而 Chat 走 OpenAI 适配器却正常，两者会不一致。
 *
 * 例外：商业代管 relay（`…/v1/proxy`）由服务端路由决定协议，保持 provider 判定。
 */
export function normalizePiApi(provider: ProviderType, baseUrl?: string): Api {
  if (provider === 'ollama' && !isLocalOllamaBaseUrl(baseUrl)) return 'openai-completions'
  if (
    provider === 'deepseek'
    && baseUrl?.trim()
    && !isRelayProxyBaseUrl(baseUrl)
    && !isAnthropicShapedEndpoint(baseUrl)
  ) {
    return 'openai-completions'
  }
  switch (provider) {
    case 'openai':
    case 'opencode-go-openai':
    case 'zhipu':
    case 'doubao':
    case 'qwen':
    case 'custom':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    case 'google':
      return 'google-generative-ai'
    default:
      return 'anthropic-messages'
  }
}

function candidatePiProviders(provider: ProviderType): KnownProvider[] {
  switch (provider) {
    case 'anthropic':
      return ['anthropic']
    case 'openai':
    case 'openai-responses':
      return ['openai']
    case 'deepseek':
      return ['deepseek']
    case 'google':
      return ['google']
    case 'kimi-api':
      return ['moonshotai-cn', 'moonshotai']
    case 'kimi-coding':
      return ['kimi-coding', 'moonshotai-cn', 'moonshotai']
    case 'zhipu':
      return ['zai']
    case 'zhipu-coding':
    case 'zhipu-coding-team':
      return ['zai-coding-cn', 'zai']
    case 'minimax':
      return ['minimax', 'minimax-cn']
    case 'xiaomi':
      return ['xiaomi']
    case 'xiaomi-token-plan':
      return ['xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'xiaomi-token-plan-ams', 'xiaomi']
    default:
      return []
  }
}

function findCatalogModelById(models: readonly PiCatalogModel[], modelId: string): PiCatalogModel | undefined {
  const normalized = modelId.toLowerCase()
  return models.find((model) => model.id.toLowerCase() === normalized || model.name.toLowerCase() === normalized)
}

async function getCatalogModels(provider: KnownProvider): Promise<readonly PiCatalogModel[]> {
  try {
    const { getModels } = await loadPiAiCompat()
    return getModels(provider as Parameters<typeof getModels>[0])
  } catch {
    return []
  }
}

async function findPiCatalogModel(provider: ProviderType, modelId: string): Promise<PiCatalogModel | undefined> {
  // DeepSeek 旧代写法（deepseek-v4-flash）与官方短名（deepseek-pro）先归一到 catalog 正式 ID：
  // 只借它的元数据（窗口/成本/最大输出/思考档位/图片能力），注册与请求仍用用户填的原始 ID。
  const catalogModelId = resolveDeepSeekV4ModelId(modelId) ?? modelId
  const checked = new Set<string>()
  for (const candidate of candidatePiProviders(provider)) {
    checked.add(candidate)
    const model = findCatalogModelById(await getCatalogModels(candidate), catalogModelId)
    if (model) return model
  }

  // 兼容自定义代理和 Anthropic-compatible：模型 id 常常仍是官方 id。
  const { getProviders } = await loadPiAiCompat()
  for (const candidate of getProviders()) {
    if (checked.has(candidate)) continue
    const model = findCatalogModelById(await getCatalogModels(candidate), catalogModelId)
    if (model) return model
  }
  return undefined
}

/**
 * 解析某 Pi 模型可用的推理档位能力（供 renderer 思考档位菜单展示）。
 *
 * 级联优先级：
 *   1. reasoning profile（deepseek-v4 / k3 / GLM-5.x / openai 推理模型）→ 精确档位
 *   2. Pi catalog 元数据（reasoning + thinkingLevelMap）→ 依模型标记
 *
 * 由 IPC 桥接给 renderer，无能力返回 undefined（renderer 回退完整七档或隐藏菜单）。
 */
export async function resolvePiReasoningCapability(provider: ProviderType, modelId: string | undefined): Promise<ReasoningCapability | undefined> {
  if (!modelId) return undefined

  const transport = inferReasoningTransport(provider)
  if (transport === 'other') return undefined

  const profile = resolveReasoningProfile({ modelId, transport })
  const catalogModel = await findPiCatalogModel(provider, modelId)
  return resolveReasoningCapability({
    profile,
    catalog: catalogModel
      ? {
          reasoning: catalogModel.reasoning,
          thinkingLevelMap: catalogModel.thinkingLevelMap,
        }
      : undefined,
  })
}

/**
 * 第三方 OpenAI 兼容网关的 finish_reason 兜底。
 *
 * Pi 的 openai-completions 适配器在 `compat.supportsFinishReason !== false` 时，会把
 * 「SSE 正常收尾但一帧都没带 finish_reason」判为整轮失败，报
 * `Stream ended without finish_reason`。而这类网关的 `/v1/chat/completions` 与
 * `/v1/responses` 往往不是同一套实现：同一渠道配在 Codex（Responses 协议）里可能完全
 * 正常，Profer 走 Chat Completions 就会撞上这条判定。
 *
 * 只对用户自配的 OpenAI 兼容渠道（provider === 'custom'）关掉该校验：
 * - 服务端给了 finish_reason 时行为完全不变（hasFinishReason 分支先行生效）；
 * - 缺失时按 stop / toolUse 推断结束原因，保住这一轮已经拿到的正文与工具调用；
 * - 真正的传输中断由底层抛网络错误，走不到这条判定，不会被静默吞掉。
 */
function applyOpenAICompatibleFinishReasonFallback(
  input: PiAgentQueryOptions,
  api: Api,
  compat: PiModelDefaults['compat'],
): PiModelDefaults['compat'] {
  if (api !== 'openai-completions' || input.provider !== 'custom') return compat
  return { ...(compat ?? {}), supportsFinishReason: false } as PiModelDefaults['compat']
}

async function resolvePiModelDefaults(
  input: PiAgentQueryOptions,
  explicit1MContext = false,
): Promise<PiModelDefaults> {
  const catalogModel = input.model ? await findPiCatalogModel(input.provider, input.model) : undefined
  const api = normalizePiApi(input.provider, input.baseUrl)
  const providerSpecificCapabilities = compilePiReasoningCapabilities(api, input.model)
  const modelId = input.model?.toLowerCase()
  const isOfficialGpt56 = input.provider === 'openai'
    && input.channelId != null
    && isOfficialManagedChannel({ id: input.channelId })
    && modelId != null
    && OFFICIAL_GPT_56_MODEL_IDS.has(modelId)
  const isOfficialGpt6Astra = input.provider === 'openai'
    && input.channelId != null
    && isOfficialManagedChannel({ id: input.channelId })
    && modelId === GPT_6_ASTRA_MODEL_ID
  const isGlm53 = modelId === 'glm-5.3'
  const isVolcengineGlm5x = (input.provider === 'doubao' || input.provider === 'ark-coding-plan') && (modelId === 'glm-5.2' || modelId === 'glm-5.3')
  // 1M 按「代际默认」判定，但同样要求 provider 已验证（如 deepseek / zhipu-coding / xiaomi…）：
  // custom、anthropic-compatible 与自建网关仍保留 catalog 的保守窗口，除非渠道模型上勾选了 1M。
  // 用户在渠道配置里显式关闭 1M 时，跳过所有 1M 判定，按保守默认窗口注册（影响 Pi 的压缩阈值）。
  const isVerifiedOneMillionContext = explicit1MContext || supportsVerified1MContext(input.model, input.provider)
  // DeepSeek 世代模型经第三方网关时，全局 catalog 会带上 1M 窗口，但不能据此假定该网关已协商 1M：
  // 保留历史行为——退回保守默认窗口，只有显式声明 1M 才认这份能力声明。
  const isRelayedDeepSeekGeneration = input.provider !== 'deepseek'
    && !explicit1MContext
    && supportsVerified1MContext(input.model, 'deepseek')
  const rawCatalogContextWindow = isRelayedDeepSeekGeneration
    ? DEFAULT_CONTEXT_WINDOW
    : (catalogModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
  const computedContextWindow = isOfficialGpt56 || isOfficialGpt6Astra
    ? CODEX_56_CONTEXT_WINDOW
    : isVerifiedOneMillionContext
      ? Math.max(rawCatalogContextWindow, ONE_MILLION_CONTEXT_WINDOW)
      : rawCatalogContextWindow
  // 渠道模型上的 1M 勾选最后统一生效（强开抬到 1M、强关压回保守窗口）。
  const contextWindow = applyModel1MContextPreference(computedContextWindow, input.context1m)
  return {
    reasoning: catalogModel?.reasoning ?? true,
    thinkingLevelMap: providerSpecificCapabilities?.thinkingLevelMap ?? catalogModel?.thinkingLevelMap,
    compat: applyOpenAICompatibleFinishReasonFallback(
      input,
      api,
      providerSpecificCapabilities?.compat,
    ),
    input: catalogModel ? [...catalogModel.input] : ['text', 'image'],
    cost: catalogModel ? { ...catalogModel.cost } : { ...ZERO_MODEL_COST },
    contextWindow,
    maxTokens: isVolcengineGlm5x ? VOLCENGINE_GLM_MAX_TOKENS : (catalogModel?.maxTokens ?? (isGlm53 ? GLM_53_MAX_TOKENS : DEFAULT_MAX_TOKENS)),
  }
}

/**
 * 按渠道模型上的 1M 偏好归一上下文窗口。
 *
 * - 强制开启：抬到 1M（能否真正協商由端点决定）
 * - 强制关闭：把 1M 级窗口压回保守默认窗口，但不抬升本来就小于默认窗口的模型
 * - 未设置：保持 catalog / 代际判定结果
 *
 * 所有注册窗口的 builder（通用、xAI、Codex）都要过这里，否则「1M」勾选在部分
 * provider 上会变成空话。
 */
export function applyModel1MContextPreference(
  contextWindow: number,
  preference?: boolean | null,
): number {
  if (preference === true) return Math.max(contextWindow, ONE_MILLION_CONTEXT_WINDOW)
  if (preference === false) return Math.min(contextWindow, DEFAULT_CONTEXT_WINDOW)
  return contextWindow
}

/** 在注册前把 1M 偏好应用到模型元数据上。 */
function applyModel1MContextPreferenceToModel(
  model: PiCatalogModel,
  preference?: boolean | null,
): PiCatalogModel {
  const contextWindow = applyModel1MContextPreference(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW, preference)
  return contextWindow === model.contextWindow ? model : { ...model, contextWindow }
}

function normalizePiBaseUrl(baseUrl: string | undefined, provider: ProviderType): string | undefined {
  if (!baseUrl) return undefined
  if (provider === 'ollama' && !isLocalOllamaBaseUrl(baseUrl)) {
    return `${baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
  }
  const api = normalizePiApi(provider, baseUrl)
  if (api === 'anthropic-messages') {
    // Pi's Anthropic SDK appends `/v1/messages` itself. Do not first resolve
    // the complete endpoint: that turns the commercial relay base
    // `/v1/proxy` into `/v1/proxy/messages`, after which Pi appends another
    // `/v1/messages` and the request lands on a 404 route.
    return normalizeAnthropicBaseUrlForSdk(baseUrl)
  }
  // DeepSeek 走 OpenAI 兼容端点时，若用户填了完整 `/chat/completions`，
  // 需先还原成协议根地址，避免 Pi 重复拼接。
  if (provider === 'custom' || provider === 'openai-responses' || provider === 'deepseek') {
    return normalizeOpenAIBaseUrlForSdk(baseUrl)
  }
  return baseUrl.trim().replace(/\/$/, '')
}

export function requiresPromaUserAgent(provider: ProviderType): boolean {
  return provider === 'kimi-coding' || provider === 'xiaomi-token-plan' || provider === 'zhipu-coding' || provider === 'zhipu-coding-team'
}

function usesBearerOnlyAnthropicAuth(provider: ProviderType): boolean {
  return requiresPromaUserAgent(provider) || provider === 'minimax' || provider === 'qwen-anthropic'
}

export function buildPiRequestHeaders(provider: ProviderType, apiKey: string, baseUrl?: string): PiRequestHeaders | undefined {
  if (normalizePiApi(provider, baseUrl) !== 'anthropic-messages') return undefined

  const headers: PiRequestHeaders = {
    Authorization: `Bearer ${apiKey || 'ollama'}`,
  }

  if (requiresPromaUserAgent(provider)) {
    headers['User-Agent'] = getProferUserAgent()
  }

  return headers
}

function shouldUseRuntimeApiKey(provider: ProviderType): boolean {
  return !usesBearerOnlyAnthropicAuth(provider)
}

/**
 * 解析出用于 Pi runtime 认证的真实 API token。
 *
 * 智谱团队版（zhipu-coding-team）的凭据是复合串（形如
 * `apiKey=xxx; bigmodel_organization=yyy; bigmodel_project=zzz`），
 * 必须先提取其中的 apiKey，否则整串会被塞进 `Authorization: Bearer` 头导致 401。
 * 与 Claude runtime 的 applyAgentSdkAuthEnv 保持一致。
 */
export function resolvePiApiKey(provider: ProviderType, apiKey: string): string {
  if (provider === 'ollama') return apiKey.trim() || 'ollama'
  return provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
}

/**
 * 剥离模型 ID 上的 `[1m]` 扩展上下文后缀。
 *
 * `[1m]` 是 Claude Agent SDK 专用的扩展上下文变体，pi runtime 及其对接的
 * 端点（智谱等）并不识别，带后缀会被判为「模型不存在」（智谱 1211）。
 * pi 模式统一剥离该后缀，保证注册与请求使用干净的模型 ID。
 */
export function stripAgentSdkContextSuffix(modelId: string | undefined): string | undefined {
  return modelId?.replace(/\[1m\]$/i, '')
}

function mergeCodexModels(models: readonly PiCatalogModel[]): PiCatalogModel[] {
  const merged = models.map((model) => ({ ...model }))
  const indexById = new Map(merged.map((model, index) => [model.id, index]))
  for (const patch of CODEX_MODEL_PATCHES) {
    const existingIndex = indexById.get(patch.id)
    const existing = existingIndex !== undefined ? merged[existingIndex] : undefined
    if (existingIndex !== undefined && existing) {
      merged[existingIndex] = { ...existing, ...patch }
    } else if (isCompleteCatalogModel(patch)) {
      indexById.set(patch.id, merged.length)
      merged.push(patch)
    }
  }
  return merged
}

function isCompleteCatalogModel(model: PiCatalogModelPatch): model is PiCatalogModel {
  return Boolean(model.name && model.api && model.provider && model.baseUrl && model.input && model.cost && model.contextWindow && model.maxTokens)
}

export async function getCodexCatalogModels(): Promise<PiCatalogModel[]> {
  const { getModels } = await loadPiAiCompat()
  return mergeCodexModels(getModels('openai-codex'))
}

/**
 * 为 ChatGPT (Codex) OAuth 渠道构建模型。
 *
 * openai-codex 是 Pi SDK 的内置 KnownProvider：模型目录、baseUrl 和
 * `openai-codex-responses` 协议全部内置，无需（也不能）手工构造 models 或 baseUrl。
 * 只需把 OAuth access token 作为 runtime key 注入到内置 provider 名 `openai-codex`
 * 下，SDK 的 getApiKey 会按 model.provider 解析到它。
 *
 * 注意：这里的 input.apiKey 必须是编排层用 resolveCodexAccessToken 解析并按需
 * 刷新后的 access token，而不是存储的凭据 JSON。
 */
async function buildCodexModelWithRuntimeKey(sdk: PiSdk, input: PiAgentQueryOptions) {
  const modelRuntime = await sdk.ModelRuntime.create(createIsolatedModelRuntimeOptions())
  // 内置 codex 模型的 provider 字段即 'openai-codex'，token 必须设在该名下。
  await modelRuntime.setRuntimeApiKey('openai-codex', input.apiKey)

  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const codexModels = await getCodexCatalogModels()
  const model =
    (resolvedModelId ? modelRuntime.getModel('openai-codex', resolvedModelId) : undefined) ??
    (resolvedModelId ? findCatalogModelById(codexModels, resolvedModelId) : undefined) ??
    // 指定模型缺失时回退到首个内置 codex 模型，避免因模型 ID 漂移直接失败。
    modelRuntime.getModels('openai-codex')[0]
  if (!model) {
    throw new Error('未找到可用的 ChatGPT (Codex) 模型，请确认已登录并升级 Pi 运行时')
  }
  return { modelRuntime, model: applyModel1MContextPreferenceToModel(applyVerifiedGpt56ContextWindow(model), input.context1m) }
}

/** 列出 Pi SDK 内置的 ChatGPT (Codex) 模型 ID，供渲染层"模型拉取"使用。 */
export async function listCodexModels(): Promise<{ id: string; name: string }[]> {
  return (await getCodexCatalogModels()).map((m) => ({
    id: m.id,
    name: m.name,
  }))
}

export async function buildModel(
  sdk: PiSdk,
  input: PiAgentQueryOptions,
): Promise<{
  modelRuntime: Awaited<ReturnType<PiSdk['ModelRuntime']['create']>>
  model: PiCatalogModel
}> {
  if (input.provider === 'openai-codex') {
    return input.codexOAuthCredentials
      ? buildCodexModel(sdk, {
          model: input.model,
          codexOAuthCredentials: input.codexOAuthCredentials,
          onCodexOAuthCredentialsRefreshed: input.onCodexOAuthCredentialsRefreshed,
          context1m: input.context1m,
        })
      : buildCodexModelWithRuntimeKey(sdk, input)
  }
  if (input.provider === 'xai') {
    if (input.xaiOAuthCredentials || input.xaiCredentialMode === 'oauth') {
      if (!input.xaiOAuthCredentials) {
        throw new Error('xAI OAuth 凭据缺失，请重新登录')
      }
      return buildXaiOAuthModel(sdk, {
        channelId: input.channelId,
        model: input.model,
        xaiOAuthCredentials: input.xaiOAuthCredentials,
        onXaiOAuthCredentialsRefreshed: input.onXaiOAuthCredentialsRefreshed,
        context1m: input.context1m,
      })
    }
    return buildXaiApiKeyModel(sdk, input)
  }
  const providerName = `profer-${input.provider}-${input.sessionId}`
  const resolvedApiKey = resolvePiApiKey(input.provider, input.apiKey)
  // Pi 请求使用干净模型 ID，但先保留用户显式 `[1m]` 配置与渠道模型上的 1M 勾选：
  // 前者供未知兼容网关声明能力，后者支持用户手动强开 / 强关。
  const explicit1MContext = /\[1m\]$/i.test(input.model ?? '') || input.context1m === true
  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const modelRuntime = await sdk.ModelRuntime.create(createIsolatedModelRuntimeOptions())
  if (shouldUseRuntimeApiKey(input.provider)) {
    await modelRuntime.setRuntimeApiKey(providerName, resolvedApiKey)
  }
  const api = normalizePiApi(input.provider, input.baseUrl)
  const modelDefaults = await resolvePiModelDefaults({ ...input, model: resolvedModelId }, explicit1MContext)
  const baseUrl = normalizePiBaseUrl(input.baseUrl, input.provider)
  if (!baseUrl) {
    throw new Error(`渠道 ${input.channelName ?? input.provider} 缺少 Base URL`)
  }
  const headers = buildPiRequestHeaders(input.provider, resolvedApiKey, input.baseUrl)
  modelRuntime.registerProvider(providerName, {
    name: input.channelName ?? providerName,
    apiKey: resolvedApiKey,
    ...(headers ? { headers } : {}),
    api,
    baseUrl,
    models: [
      {
      id: resolvedModelId ?? 'default',
      name: resolvedModelId ?? 'Default',
      api,
      baseUrl,
      reasoning: modelDefaults.reasoning,
        thinkingLevelMap: modelDefaults.thinkingLevelMap,
        compat: modelDefaults.compat,
      input: modelDefaults.input,
      cost: modelDefaults.cost,
      contextWindow: modelDefaults.contextWindow,
      maxTokens: modelDefaults.maxTokens,
      },
    ],
  })
  const model = modelRuntime.getModel(providerName, resolvedModelId ?? 'default')
  if (!model) throw new Error(`Pi model registration failed: ${resolvedModelId ?? 'default'}`)
  return { modelRuntime, model }
}

type CodexRuntimeCredential = CodexOAuthCredentials & {
  type: 'oauth'
  [key: string]: unknown
}

/** Pi 内置 Codex provider 所需的最小模型与 OAuth 输入。 */
export interface CodexModelInput {
  model?: string
  codexOAuthCredentials?: CodexOAuthCredentials
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
  /** 渠道模型上的 1M 偏好；仅 Agent 链路传入，标题生成等轻量请求不需要。 */
  context1m?: boolean | null
}

function createCodexRuntimeCredentialStore(initial: CodexOAuthCredentials, onRefreshed?: CodexModelInput['onCodexOAuthCredentialsRefreshed']) {
  let credential: CodexRuntimeCredential | undefined = {
    type: 'oauth',
    ...initial,
  }

  return {
    async read(providerId: string): Promise<CodexRuntimeCredential | undefined> {
      return providerId === 'openai-codex' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'openai-codex', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      fn: (current: CodexRuntimeCredential | undefined) => Promise<CodexRuntimeCredential | undefined>,
    ): Promise<CodexRuntimeCredential | undefined> {
      if (providerId !== 'openai-codex') return undefined
      const previous = credential
      credential = await fn(credential)

      if (
        credential &&
        (previous?.access !== credential.access ||
          previous?.refresh !== credential.refresh ||
          previous?.expires !== credential.expires ||
          previous?.accountId !== credential.accountId)
      ) {
        try {
          await onRefreshed?.(credential)
        } catch (error) {
          console.warn('[Pi Codex OAuth] 刷新后的凭据回写失败，将在下次执行前重试:', error)
        }
      }
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'openai-codex') credential = undefined
    },
  }
}

/**
 * 为 ChatGPT (Codex) OAuth 渠道构建模型（OAuth credential store 版）。
 *
 * 与上方 buildModel 的 setRuntimeApiKey 路径不同，此入口接收完整 OAuth 凭据并放入
 * 一次性内存 credential store，按真实 expires 刷新并回写 Profer，避免读写全局 ~/.pi。
 * 标题生成等轻量请求使用此入口；前台 Agent query 仍走 buildModel。
 */
export async function buildCodexModel(sdk: PiSdk, input: CodexModelInput) {
  if (!input.codexOAuthCredentials) {
    throw new Error('ChatGPT (Codex) OAuth 凭据缺失，请重新登录')
  }

  const modelRuntime = await sdk.ModelRuntime.create(createIsolatedModelRuntimeOptions(
    createCodexRuntimeCredentialStore(input.codexOAuthCredentials, input.onCodexOAuthCredentialsRefreshed),
  ))

  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const codexModels = await getCodexCatalogModels()
  const model =
    (resolvedModelId ? modelRuntime.getModel('openai-codex', resolvedModelId) : undefined) ??
    (resolvedModelId ? findCatalogModelById(codexModels, resolvedModelId) : undefined) ??
    // 指定模型缺失时回退到首个内置 codex 模型，避免因模型 ID 漂移直接失败。
    modelRuntime.getModels('openai-codex')[0]
  if (!model) {
    throw new Error('未找到可用的 ChatGPT (Codex) 模型，请确认已登录并升级 Pi 运行时')
  }
  return { modelRuntime, model: applyModel1MContextPreferenceToModel(applyVerifiedGpt56ContextWindow(model), input.context1m) }
}

type XaiRuntimeCredential = XaiOAuthCredentials & {
  type: 'oauth'
  [key: string]: unknown
}

/** Pi 内置 xAI provider 所需的最小模型与 OAuth 输入。 */
export interface XaiModelInput {
  channelId?: string
  model?: string
  xaiOAuthCredentials?: XaiOAuthCredentials
  onXaiOAuthCredentialsRefreshed?: (credentials: XaiOAuthCredentials) => void | Promise<void>
  /** 渠道模型上的 1M 偏好；仅 Agent 链路传入。 */
  context1m?: boolean | null
}

function createXaiRuntimeCredentialStore(channelId: string, initial: XaiOAuthCredentials, onRefreshed?: XaiModelInput['onXaiOAuthCredentialsRefreshed']) {
  let credential: XaiRuntimeCredential | undefined = {
    type: 'oauth',
    ...rememberXaiOAuthCredentials(channelId, initial),
  }

  return {
    async read(providerId: string): Promise<XaiRuntimeCredential | undefined> {
      return providerId === 'xai' ? credential : undefined
    },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'xai', type: 'oauth' }] : []
    },
    async modify(
      providerId: string,
      fn: (current: XaiRuntimeCredential | undefined) => Promise<XaiRuntimeCredential | undefined>,
    ): Promise<XaiRuntimeCredential | undefined> {
      if (providerId !== 'xai' || !credential) return undefined
      const previous = credential
      const refreshed = await refreshXaiOAuthCredentialsSerial(channelId, credential, async (latest) => {
          const next = await fn({ type: 'oauth', ...latest })
          if (!next) throw new Error('Pi xAI OAuth 刷新未返回凭据')
        return {
          access: next.access,
          refresh: next.refresh,
          expires: next.expires,
        }
      })
      credential = { type: 'oauth', ...refreshed }
      if (previous.access !== credential.access || previous.refresh !== credential.refresh || previous.expires !== credential.expires) {
        try {
          await onRefreshed?.(credential)
        } catch (error) {
          console.warn('[Pi xAI OAuth] 刷新后的凭据回写失败，将在下次执行前重试:', error)
        }
      }
      return credential
    },
    async delete(providerId: string): Promise<void> {
      if (providerId === 'xai') credential = undefined
    },
  }
}

/** 列出 Pi SDK 内置的 xAI（Grok）模型 ID，供订阅登录后拉取模型使用。 */
export async function listXaiModels(): Promise<{ id: string; name: string }[]> {
  const { getModels } = await loadPiAiCompat()
  return [...getModels('xai')].map((m) => ({ id: m.id, name: m.name }))
}

/**
 * 为 xAI API Key 渠道构建隔离的 Responses provider。
 *
 * API Key 渠道既可以直连官方 xAI，也可以指向返回任意模型 ID 的 Responses 中转站。
 * 因此不能只依赖 Pi 内置 xai catalog：已知模型复用 catalog 能力，未知模型在当前
 * runtime 注册保守元数据；API key 仍只写入当前 runtime 的 credential store。
 */
async function buildXaiApiKeyModel(sdk: PiSdk, input: PiAgentQueryOptions) {
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new Error('xAI API Key 缺失，请在渠道设置中填写 API Key')

  const modelRuntime = await sdk.ModelRuntime.create(createIsolatedModelRuntimeOptions())
  await modelRuntime.setRuntimeApiKey('xai', apiKey)

  const resolvedModelId = stripAgentSdkContextSuffix(input.model) ?? 'grok-4.6'
  const { getModels } = await loadPiAiCompat()
  const xaiModels = [...getModels('xai')]
  const catalogModel = findCatalogModelById(xaiModels, resolvedModelId)
  const baseUrl = normalizeOpenAIBaseUrlForSdk(input.baseUrl ?? catalogModel?.baseUrl ?? '')
  if (!baseUrl) throw new Error('xAI Responses 渠道缺少 Base URL')

  const reasoningCapabilities = compilePiReasoningCapabilities('openai-responses', resolvedModelId)
  const modelConfig = {
    id: resolvedModelId,
    name: catalogModel?.name ?? resolvedModelId,
    api: 'openai-responses' as const,
    reasoning: catalogModel?.reasoning ?? true,
    thinkingLevelMap: reasoningCapabilities?.thinkingLevelMap ?? catalogModel?.thinkingLevelMap,
    compat: reasoningCapabilities?.compat ?? catalogModel?.compat,
    input: catalogModel ? [...catalogModel.input] : ['text', 'image'] as ('text' | 'image')[],
    cost: catalogModel ? { ...catalogModel.cost } : { ...ZERO_MODEL_COST },
    contextWindow: applyModel1MContextPreference(catalogModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, input.context1m),
    maxTokens: catalogModel?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }

  modelRuntime.registerProvider('xai', {
    name: 'xAI / Grok',
    api: 'openai-responses',
    baseUrl,
    models: [modelConfig],
  })

  const model = modelRuntime.getModel('xai', resolvedModelId)
  if (!model) throw new Error(`xAI Responses 模型注册失败: ${resolvedModelId}`)
  return { modelRuntime, model }
}

export async function buildXaiOAuthModel(sdk: PiSdk, input: XaiModelInput) {
  if (!input.xaiOAuthCredentials || !input.channelId) {
    throw new Error('xAI OAuth 凭据或渠道标识缺失，请重新登录')
  }
  const modelRuntime = await sdk.ModelRuntime.create(createIsolatedModelRuntimeOptions(
    createXaiRuntimeCredentialStore(input.channelId, input.xaiOAuthCredentials, input.onXaiOAuthCredentialsRefreshed),
  ))
  const resolvedModelId = stripAgentSdkContextSuffix(input.model)
  const { getModels } = await loadPiAiCompat()
  const xaiModels = [...getModels('xai')]
  const model =
    (resolvedModelId ? modelRuntime.getModel('xai', resolvedModelId) : undefined) ??
    (resolvedModelId ? findCatalogModelById(xaiModels, resolvedModelId) : undefined) ??
    modelRuntime.getModels('xai')[0]
  if (!model) {
    throw new Error('未找到可用的 xAI（Grok）模型，请确认订阅已授权并升级 Pi 运行时')
  }
  return { modelRuntime, model: applyModel1MContextPreferenceToModel(model, input.context1m) }
}
