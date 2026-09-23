/**
 * 模型上下文窗口推断 — 单一 source of truth。
 *
 * 后端（agent-orchestrator 是否发 `context-1m-2025-08-07` beta）和
 * 前端（ContextUsageBadge 进度环分母 fallback）必须共用同一份判定，
 * 否则会出现"UI 显示 1M 但实际只 200K"或反过来的不一致。
 */

import type { ProviderType } from '../types/channel'
import { DEEPSEEK_V4_SHORT_MODEL_NAMES, resolveDeepSeekV4ModelId, normalizeModelIdTail } from '../types/deepseek-model-alias'

/** 默认上下文窗口（无法识别模型时使用） */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** 1M 上下文窗口 */
export const ONE_MILLION_CONTEXT_WINDOW = 1_000_000
/** ChatGPT Codex GPT-5.4 / 5.5 / 5.6 / 6.x 的已验证上下文窗口 */
export const CODEX_GPT_CONTEXT_WINDOW = 1_050_000
/** ChatGPT Codex GPT-5.4 mini 的已验证窗口；同代里明显更小，需排除在 1M / 1.05M 规则之外 */
export const CODEX_GPT_54_MINI_CONTEXT_WINDOW = 400_000

/** GPT-5.4 mini：同代已验证窗口仅 400K，不能跟着世代规则升到 1M。 */
const GPT_54_MINI_MODEL_ID = 'gpt-5.4-mini'
/** GPT / Codex 世代进入 1M 的起点版本（mini 档位除外）。 */
const GPT_GENERATION_MIN_VERSION = '5.4'
/** Kimi K3 短 ID；需精确匹配，避免误伤其它含 "k3" 子串的模型名。 */
const KIMI_K3_SHORT_MODEL_ID = 'k3'
/**
 * DeepSeek 自 V4 代起在官方 API 提供的无版本号短名（与带版本号 ID 同代、同窗口）。
 * 渠道里手填的模型 ID 常常就是这类短名，缺了它会导致 1M 判定回落到 200K。
 * 短名清单源在 deepseek-model-alias，与「需要归一的别名」分开维护。
 */
const DEEPSEEK_SHORT_MODEL_NAMES: readonly string[] = DEEPSEEK_V4_SHORT_MODEL_NAMES

export interface ModelUsageContextInfo {
  contextWindow?: number
}

/**
 * 规范化用于上下文能力匹配的模型 ID。
 * 去除 Claude Agent SDK 私有的 `[1m]` 后缀，并保留最后一个路径段以兼容网关前缀。
 */
export function normalizeContextModelId(modelId?: string): string | undefined {
  return normalizeModelIdTail(modelId)
}

/**
 * 仅 DeepSeek V4 Pro / Flash 是当前产品已确认的 1M DeepSeek 模型。
 *
 * 基于归一后的 ID 判定，因此同一个模型无论写成 0.86 起的 `deepseek-flash`、
 * 旧代的 `deepseek-v4-flash`，还是官方短名 `deepseek-pro`，都会归入同一族，
 * 不会因写法不同而让思考协议、成本与窗口漂移。
 */
export function isDeepSeekV4Model(modelId?: string): boolean {
  const model = resolveDeepSeekV4ModelId(modelId)
  return model != null && /^(?:deepseek-flash|deepseek-v4-pro)$/.test(model)
}

/** 把 "4.6" / "5-4" 这类版本串解析为可逐位比较的数字段。 */
function parseVersionSegments(version: string): number[] {
  const segments: number[] = []
  for (const segment of version.split(/[.\-_]/)) {
    if (!/^\d+$/.test(segment)) break
    segments.push(Number(segment))
  }
  return segments
}

/** 逐位比较版本：缺失段按 0 处理，返回 a >= b。 */
function isVersionAtLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

/**
 * 1M 上下文代际规则。
 *
 * 基线 = DeepSeek V4 这一代：该代及之后发布的模型家族默认按 1M 处理。
 * 每个家族只声明「进入 1M 的最低版本」，家族内更高版本（含未来新版本）自动继承，
 * 新 SKU 不需要再来这里逐个加白名单。
 */
interface OneMillionFamilyRule {
  /** 家族前缀；前缀之后的数字段参与版本比较 */
  prefix: string
  /** 进入 1M 的最低版本，如 '4.6'；'.' 与 '-' 等价 */
  minVersion: string
  /** 版本号低于阈值、但产品已确认 1M 的 SKU（精确匹配，不受 prefix 约束） */
  exact?: readonly string[]
  /**
   * 家族内不带版本号的官方短名前缀（如 DeepSeek 的 deepseek-flash / deepseek-pro）。
   * 按前缀匹配，同代新变体（deepseek-flash-latest）自动继承，不受 minVersion 约束。
   */
  shortNames?: readonly string[]
  /** 同家族中明确不属于 1M 的 SKU */
  exclude?: (modelId: string) => boolean
}

const ONE_MILLION_FAMILY_RULES: readonly OneMillionFamilyRule[] = [
  // Claude：Sonnet 4+、Opus 4.6+、Fable 5+（Haiku 一律不支持，见提前返回）
  { prefix: 'claude-sonnet-', minVersion: '4' },
  { prefix: 'claude-opus-', minVersion: '4.6' },
  { prefix: 'claude-fable-', minVersion: '5' },
  // GPT：5.4 及之后的 GPT / Codex 世代；mini 档位实测窗口更小，单独排除
  { prefix: 'gpt-', minVersion: GPT_GENERATION_MIN_VERSION, exclude: (modelId) => modelId.includes('mini') },
  // DeepSeek：V4 及之后（v5+ 自动继承）；deepseek-flash / deepseek-pro 为 V4 起的官方无版本号短名，
  // 其中 deepseek-flash 自 0.86 起就是带图能力的 catalog 正式 ID
  { prefix: 'deepseek-v', minVersion: '4', shortNames: DEEPSEEK_SHORT_MODEL_NAMES },
  // Kimi：K3 及之后（K4+ 自动继承）
  { prefix: 'kimi-k', minVersion: '3' },
  // 智谱：GLM-5.2 及之后（GLM-6+ 自动继承）
  { prefix: 'glm-', minVersion: '5.2' },
  // 小米 MiMo：V2.5 及之后；V2 Pro 为已确认 SKU，V2 Omni / Flash 不在其列
  { prefix: 'mimo-v', minVersion: '2.5', exact: ['mimo-v2-pro'] },
  // MiniMax：M3 及之后
  { prefix: 'minimax-m', minVersion: '3' },
  // xAI：Grok 4.6 及之后
  { prefix: 'grok-', minVersion: '4.6' },
]

function matchesOneMillionFamilyRule(model: string, rule: OneMillionFamilyRule): boolean {
  if (rule.exact?.includes(model)) return true
  // 无版本号官方短名：整族按 1M 处理，同代新变体自动继承
  if (rule.shortNames?.some((shortName) => model.startsWith(shortName))) return true
  if (!model.startsWith(rule.prefix)) return false
  if (rule.exclude?.(model)) return false
  return isVersionAtLeast(
    parseVersionSegments(model.slice(rule.prefix.length)),
    parseVersionSegments(rule.minVersion),
  )
}

/**
 * 判断模型是否属于「DeepSeek 这一代及之后」的 1M 上下文家族。
 *
 * 只做模型侧判定（家族 + 版本阈值），不代表某条 provider 链路已验证过 1M 协商；
 * provider 侧能力见 supportsVerified1MContext。
 */
export function isNextGeneration1MContextModel(modelId?: string): boolean {
  const model = normalizeContextModelId(modelId)
  if (!model || model.includes('haiku')) return false
  // Kimi K3 短 ID（精确匹配，避免误匹配其他含 "k3" 子串的模型名）
  if (model === KIMI_K3_SHORT_MODEL_ID || model.startsWith(`${KIMI_K3_SHORT_MODEL_ID}[`)) return true
  return ONE_MILLION_FAMILY_RULES.some((rule) => matchesOneMillionFamilyRule(model, rule))
}

/**
 * 判断模型是否支持 1M context window beta（context-1m-2025-08-07）。
 *
 * 采用「代际默认」规则（见 ONE_MILLION_FAMILY_RULES）：DeepSeek V4 这一代及之后的
 * 模型家族都按 1M 处理，家族新版本自动继承，不再逐个 SKU 维护白名单。
 *
 * 当前覆盖：Claude Sonnet 4+ / Opus 4.6+ / Fable 5、GPT-5.4+（mini 除外）、
 * DeepSeek V4+（含官方无版本号短名 deepseek-flash / deepseek-pro，以及旧的 deepseek-v4-flash 写法）、Kimi K3+、
 * 智谱 GLM-5.2+、小米 MiMo V2.5+（含已确认的 V2 Pro）、MiniMax M3+、Grok 4.6+，
 * 以及显式声明 `[1m]` 的 GLM-X-Preview。
 *
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/context-windows
 */
export function supports1MContext(modelId: string): boolean {
  if (!modelId) return false
  const m = normalizeContextModelId(modelId)
  if (!m || m.includes('haiku')) return false
  // 未知兼容网关可用显式 `[1m]` 后缀声明 1M（如 GLM-X-Preview[1m]）
  if (/\[1m\]$/i.test(modelId.trim()) && m.includes('glm-x-preview')) return true
  return isNextGeneration1MContextModel(m)
}

/** GPT mini 档位：同代中窗口明显更小，不参与 1M / 1.05M 世代规则。 */
function isGptMiniSku(modelId: string): boolean {
  return modelId.startsWith('gpt-') && modelId.includes('mini')
}

/** GPT-5.4 及之后的 Codex / GPT 世代走已验证的 1.05M 窗口。 */
function isCodexGenerationGptModel(modelId: string): boolean {
  return modelId.startsWith('gpt-')
    && !isGptMiniSku(modelId)
    && isVersionAtLeast(
      parseVersionSegments(modelId.slice('gpt-'.length)),
      parseVersionSegments(GPT_GENERATION_MIN_VERSION),
    )
}

/**
 * 按模型名推断 contextWindow（token 数）。
 *
 * SDK 流式过程中不返回此字段，只有 result 消息的 modelUsage 才带（且部分渠道不返回）。
 * 本函数提供一个按模型家族的 fallback，保证进度环永远有分母可用。
 */
export function inferContextWindow(model?: string): number | undefined {
  if (!model) return undefined
  const normalized = normalizeContextModelId(model)
  if (!normalized) return DEFAULT_CONTEXT_WINDOW
  if (isGptMiniSku(normalized)) {
    return normalized === GPT_54_MINI_MODEL_ID ? CODEX_GPT_54_MINI_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW
  }
  if (isCodexGenerationGptModel(normalized)) return CODEX_GPT_CONTEXT_WINDOW
  if (supports1MContext(model)) return ONE_MILLION_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 已验证会把 `[1m]` 后缀协商成 1M 上下文的 provider → 允许的模型家族前缀。
 *
 * 家族内的版本阈值统一走 ONE_MILLION_FAMILY_RULES（家族新版本自动继承），
 * 避免两处白名单漂移；未列出的 provider（custom、anthropic-compatible、自建网关等）
 * 不会仅凭模型名被追加后缀。
 */
const AGENT_SDK_1M_PROVIDER_FAMILIES: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: ['claude-sonnet-', 'claude-opus-', 'claude-fable-'],
  deepseek: ['deepseek-v', ...DEEPSEEK_SHORT_MODEL_NAMES],
  'kimi-api': ['kimi-k', KIMI_K3_SHORT_MODEL_ID],
  'kimi-coding': ['kimi-k', KIMI_K3_SHORT_MODEL_ID],
  zhipu: ['glm-'],
  'zhipu-coding': ['glm-'],
  'zhipu-coding-team': ['glm-'],
  'ark-coding-plan': ['glm-'],
  doubao: ['glm-'],
  minimax: ['minimax-m'],
  xiaomi: ['mimo-v'],
  'xiaomi-token-plan': ['mimo-v'],
}

function matchesFamilyPrefix(modelId: string, family: string): boolean {
  return family === KIMI_K3_SHORT_MODEL_ID ? modelId === family : modelId.startsWith(family)
}

/**
 * provider + 模型是否为已验证的 1M 组合：既要求模型属于 1M 世代家族，也要求 provider 在白名单内。
 * Pi 运行时同样用这个判定决定是否按 1M 注册上下文窗口，保证两条链路一致。
 */
export function supportsVerified1MContext(modelId: string | undefined, provider?: ProviderType): boolean {
  if (!modelId || !provider) return false
  const families = AGENT_SDK_1M_PROVIDER_FAMILIES[provider]
  const model = normalizeContextModelId(modelId)
  if (!families || !model || !isNextGeneration1MContextModel(model)) return false
  return families.some((family) => matchesFamilyPrefix(model, family))
}

/**
 * 为经过验证的 provider/model 组合选择 Claude SDK 1M 变体。
 * boolean 参数保留给已显式完成协议协商的调用方；provider 参数不会向未知兼容端点修改模型 ID。
 */
export function resolveAgentSdkModelId(modelId: string, provider?: ProviderType): string
export function resolveAgentSdkModelId(modelId: string, enable1MContext: boolean): string
export function resolveAgentSdkModelId(modelId: string, providerOrEnabled?: ProviderType | boolean): string {
  if (!modelId || /\[1m\]$/i.test(modelId)) return modelId
  if (typeof providerOrEnabled === 'boolean') return providerOrEnabled ? `${modelId}[1m]` : modelId
  return supportsVerified1MContext(modelId, providerOrEnabled) ? `${modelId}[1m]` : modelId
}

/**
 * 去掉 Claude SDK 专用的 `[1m]` 变体后缀。
 *
 * 该后缀只对 Claude Agent SDK 有意义（模型变体 + beta 協商）；一旦把它交给供应商 API
 * （标题生成、探测请求等）就会指向不存在的模型 ID。只在「模型 ID 即将出门」时使用，
 * 不要用它去规范化用户配置里手填的 ID。
 */
export function strip1MContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, '')
}

/** 1M 上下文的生效来源，供 UI 区分「自动」与「手动覆盖」。 */
export type OneMillionContextSource = 'auto' | 'forced-on' | 'forced-off'

export interface OneMillionContextDecision {
  /** 最终是否按 1M 上下文处理 */
  enabled: boolean
  /** 生效来源：自动判定 / 手动强制开启 / 手动强制关闭 */
  source: OneMillionContextSource
  /** 不带人工覆盖时的自动判定结果（即模型 + provider 是否已验证） */
  autoEnabled: boolean
}

/**
 * 解析 1M 上下文的三态决策。
 *
 * 渠道配置里的显式偏好（渠道模型的 `context1m`）优先于自动判定：
 * - `true`：任何模型 / 网关都强开（能不能真协商由端点决定）
 * - `false`：即使模型与 provider 都验证支持也不按 1M 处理
 * - 缺省：回落到模型 + provider 白名单（历史行为）
 */
export function resolveOneMillionContextDecision(
  modelId: string | undefined,
  provider: ProviderType | undefined,
  explicit?: boolean | null,
): OneMillionContextDecision {
  const autoEnabled = supportsVerified1MContext(modelId, provider)
  if (explicit === true) return { enabled: true, source: 'forced-on', autoEnabled }
  if (explicit === false) return { enabled: false, source: 'forced-off', autoEnabled }
  return { enabled: autoEnabled, source: 'auto', autoEnabled }
}

export interface AgentSdk1MSelection {
  /** 实际交给 Claude SDK 的模型 ID（需要时追加 `[1m]` 变体后缀） */
  modelId: string
  /** 是否注入 `context-1m-2025-08-07` beta */
  oneMillionContextEnabled: boolean
  /** 生效来源 */
  source: OneMillionContextSource
}

/**
 * 解析本轮交给 Claude SDK 的 1M 选择：模型 ID 变体与 beta 注入必须同时决定。
 *
 * 只有后缀没有 beta，SDK 不会按 1M 协商；只有 beta 没有后缀，请求仍走默认窗口。
 * 两者共享同一个决策，避免两处判定漂移（含用户在渠道里显式写入 `[1m]` 的模型）。
 */
export function resolveAgentSdk1MSelection(
  modelId: string,
  provider: ProviderType | undefined,
  explicit?: boolean | null,
): AgentSdk1MSelection {
  if (!modelId) return { modelId, oneMillionContextEnabled: false, source: 'auto' }
  const decision = resolveOneMillionContextDecision(modelId, provider, explicit)
  const hasSuffix = /\[1m\]$/i.test(modelId)
  return {
    modelId: decision.enabled && !hasSuffix ? `${modelId}[1m]` : modelId,
    oneMillionContextEnabled: decision.enabled,
    source: decision.source,
  }
}

/** 按实际 provider 推断 Agent SDK 上下文窗口，不向未知代理假设 1M 协议。 */
export function inferAgentSdkContextWindow(modelId: string | undefined, provider?: ProviderType): number | undefined {
  if (!modelId) return undefined
  return resolveAgentSdkModelId(modelId, provider) !== modelId || /\[1m\]$/i.test(modelId)
    ? ONE_MILLION_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * 从多模型 result 选择本轮上下文窗口。
 * 优先选择配置的主模型；无法定位时使用最大的实测窗口，避免误取首个子 Agent 模型。
 */
export function resolveContextWindowFromModelUsage(
  modelUsage?: Record<string, ModelUsageContextInfo>,
  preferredModelId?: string,
  fallbackModelId?: string,
): number | undefined {
  const entries = Object.entries(modelUsage ?? {})
  const canonicalize = (modelId?: string) => modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  const preferredCanonical = canonicalize(preferredModelId)

  if (preferredCanonical) {
    const exactEntry = entries.find(([modelId]) => canonicalize(modelId) === preferredCanonical)
    if (exactEntry) return exactEntry[1].contextWindow
      ?? inferContextWindow(preferredModelId)
      ?? inferContextWindow(exactEntry[0])

    const preferredTail = normalizeContextModelId(preferredModelId)
    const tailMatches = entries.filter(([modelId]) => normalizeContextModelId(modelId) === preferredTail)
    if (tailMatches.length === 1) {
      const [modelId, info] = tailMatches[0]!
      return info.contextWindow
        ?? inferContextWindow(preferredModelId)
        ?? inferContextWindow(modelId)
    }
  }

  let largest: number | undefined
  for (const [modelId, info] of entries) {
    const window = info.contextWindow ?? inferContextWindow(modelId)
    if (window != null && (largest == null || window > largest)) largest = window
  }
  return largest ?? inferContextWindow(fallbackModelId)
}
