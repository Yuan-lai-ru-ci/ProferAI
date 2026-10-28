import type { AgentRuntimeMode, ProviderType, XaiApiProtocol } from './channel'
import type { AgentThinkingLevel } from './agent'
import type { ReasoningModelTag } from './reasoning-model-tag'
import { resolveReasoningModelTag } from './reasoning-model-tag'
import { resolveProviderNativeProtocol } from './provider-capability'

/** 家族 tag 判定与 Claude adaptive 判定在 reasoning-model-tag 里维护，这里继续对外导出。 */
export { isClaudeAdaptiveThinkingModel, resolveReasoningModelTag } from './reasoning-model-tag'
export type { ReasoningModelTag, ReasoningModelTagRule } from './reasoning-model-tag'

/** Proma 可识别的 reasoning 请求协议族。 */
export type ReasoningTransport =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'other'

/**
 * 将渠道归类到其实际的 reasoning 请求协议。
 *
 * 渠道名不能直接决定请求字段；profile 必须同时匹配模型 ID 和 transport，
 * 才能避免把 OpenAI 的 reasoning_effort 发送到 Anthropic endpoint。
 */
export function inferReasoningTransport(
  provider: ProviderType | undefined,
  baseUrl?: string,
  xaiApiProtocol?: XaiApiProtocol,
): ReasoningTransport {
  // 与 normalizePiApi 共用同一份协议判定（resolveProviderNativeProtocol），
  // 避免渲染层思考档位菜单与运行时请求注入各猜各的：deepseek 接第三方
  // OpenAI 网关时，菜单判成 anthropic-messages 而请求按 openai-completions
  // 跳过注入，会让用户选的档位静默无效。baseUrl 缺省时退化为静态默认。
  if (!provider) return 'anthropic-messages'
  switch (resolveProviderNativeProtocol(provider, baseUrl, xaiApiProtocol)) {
    case 'openai-completions':
      return 'openai-completions'
    case 'openai-responses':
      return 'openai-responses'
    case 'google-generative-ai':
      return 'other'
    default:
      return 'anthropic-messages'
  }
}

/** 编译器据此生成 runtime 专属请求参数。 */
export type ReasoningEncodingKind =
  | 'adaptive-effort'
  | 'deepseek-output-effort'
  | 'openai-reasoning-effort'
  | 'qwen-thinking-effort'
  | 'zai-thinking-effort'
  | 'provider-toggle'
  | 'anthropic-manual'

/** 每个产品等级映射为目标协议可接受的 effort 值。 */
export type ReasoningEffortMap = Partial<Record<AgentThinkingLevel, string | null>>

export interface ReasoningEncoding {
  kind: ReasoningEncodingKind
  effortMap: ReasoningEffortMap
}

export interface ReasoningProfile {
  id: 'deepseek-v4-flash' | 'deepseek-v4-pro' | 'kimi-k3' | 'kimi-k2.6-toggle' | 'kimi-k2.7-always-on' | 'glm-5.2' | 'glm-5.3' | 'glm-legacy-toggle' | 'grok-4.3' | 'grok-4.5' | 'grok-4.6' | 'qwen-3.8' | 'qwen-toggle' | 'mimo-toggle' | 'openai-reasoning-standard' | 'openai-reasoning-max' | 'openai-reasoning-gpt6' | 'claude-adaptive'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  normalize(level: AgentThinkingLevel | undefined): AgentThinkingLevel
  encodings: Partial<Record<ReasoningTransport, ReasoningEncoding>>
}

/** Pi model catalog 中与会话级 reasoning 选择有关的最小元数据。 */
export interface PiCatalogReasoningMetadata {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>
}

/**
 * 可跨主进程和渲染进程传输的 reasoning capability。
 *
 * 除档位集合外还带 `effortMap`：同一个产品档位在不同模型上会编码成不同的
 * provider 值（DeepSeek V4 Pro 的 low 实际发 high），界面需要它才能如实展示
 * 「所选档位」与「实际请求强度」的差异。
 */
export interface ReasoningCapability {
  source: 'profile' | 'pi-catalog'
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  /** 档位 → 实际请求值；缺省表示未知，null 表示该档不产生显式参数。 */
  effortMap?: ReasoningEffortMap
}

export interface ResolveReasoningCapabilityInput {
  profile?: ReasoningProfile
  /** profile 命中时当前 transport 选中的编码，决定 capability 暴露的 effortMap。 */
  encoding?: ReasoningEncoding
  catalog?: PiCatalogReasoningMetadata
}

export interface ResolveReasoningProfileInput {
  modelId: string | undefined
  transport: ReasoningTransport
}

// DeepSeek 官方 effort 只有 low / high / max 三个值（Pro 只有 high / max）。
// 只暴露能产生不同请求值的档位：Flash 的「更高」与「高」同值、Pro 的「低」与「高」同值，
// 留着会让界面出现两个选不同档位、实际发同一个值的假档。
const DEEPSEEK_V4_FLASH_LEVELS = ['off', 'low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const DEEPSEEK_V4_PRO_LEVELS = ['off', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
// Kimi K3/K3.1 始终思考，只有 low/high/max 三档（官方默认 max）。
const K3_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
// Kimi K2.6：thinking 开关；K2.7 Code：思考强制开启，没有可选档位。
const KIMI_K2_6_LEVELS = ['off', 'high'] as const satisfies readonly AgentThinkingLevel[]
const KIMI_K2_7_LEVELS = ['high'] as const satisfies readonly AgentThinkingLevel[]
const GLM_52_LEVELS = ['off', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
// GLM-5.3 起思考强制开启，官方 reasoning_effort 为 low/high/max。
const GLM_53_LEVELS = ['low', 'high', 'max'] as const satisfies readonly AgentThinkingLevel[]
const QWEN_38_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly AgentThinkingLevel[]
// 只有 thinking 开关的家族（MiMo / 旧 GLM / Qwen3.x / Kimi K2.6）共用的两档。
const TOGGLE_LEVELS = ['off', 'high'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_STANDARD_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
const OPENAI_MAX_LEVELS = [...OPENAI_STANDARD_LEVELS, 'max'] as const satisfies readonly AgentThinkingLevel[]

// DeepSeek Anthropic compatibility only honors output_config.effort. The official
// V4 Flash and Pro mappings differ at low and xhigh; off is handled by emitting
// `thinking: { type: 'disabled' }` rather than an effort value.
const DEEPSEEK_V4_FLASH_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: 'high',
  max: 'max',
}
const DEEPSEEK_V4_PRO_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: null,
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const K3_EFFORT_MAP: ReasoningEffortMap = {
  // 思考始终开启：off 必须为 null，Pi 才会省略 thinking 字段而不是发 disabled。
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_OPENAI_EFFORT_MAP: ReasoningEffortMap = {
  minimal: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

const GLM_52_ANTHROPIC_EFFORT_MAP: ReasoningEffortMap = {
  minimal: 'high',
  low: 'high',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// GLM-5.3 起取消关闭思考，官方只接受 reasoning_effort 的 low / high / max；
// 产品档位里的 medium 向上映射到 high，xhigh 映射到 max（官方没有 xhigh）。
const GLM_53_THINKING_LEVEL_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

// Kimi K2.x 只有 thinking 开关：off 必须留空（Pi 据此发 thinking.type=disabled），
// 其余档位显式置 null，避免界面把同一个「开」拆成四个假档位。
const THINKING_TOGGLE_LEVEL_MAP: ReasoningEffortMap = {
  minimal: null,
  low: null,
  medium: null,
  xhigh: null,
  max: null,
}

// K2.7 Code 只接受 thinking.type=enabled，off 也必须被拒绝。
const THINKING_ALWAYS_ON_LEVEL_MAP: ReasoningEffortMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  xhigh: null,
  max: null,
}

// Qwen3.8 官方档位是 low / medium / xhigh：产品的「高」落到 xhigh（官方最高档），
// 没有独立的 medium 以上档位，因此不再单列 xhigh / max。
const QWEN_38_EFFORT_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'xhigh',
  xhigh: 'xhigh',
  max: 'xhigh',
}

// Pi uses this sparse map as an override for its native level mapping. In particular,
// off must become none because OpenAI reasoning models otherwise default to medium.
const OPENAI_STANDARD_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  xhigh: 'xhigh',
}
const OPENAI_MAX_EFFORT_MAP: ReasoningEffortMap = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: 'max',
}

const GROK_46_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly AgentThinkingLevel[]
// Grok 4.6 起思考始终开启，官方只有 low/medium/high/xhigh（没有 off / max）。
const GROK_46_EFFORT_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
}

// Grok 4.5：最高只到 high，同样不能关闭思考。
const GROK_45_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly AgentThinkingLevel[]
const GROK_45_EFFORT_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

// Grok 4.3：可关闭思考（off → none），最高只到 high。
const GROK_43_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly AgentThinkingLevel[]
const GROK_43_EFFORT_MAP: ReasoningEffortMap = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

function normalizeDeepSeekV4Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
      return 'off'
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeK3Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

function normalizeGlm52Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  return level === 'xhigh' || level === 'max' ? 'max' : 'high'
}

function normalizeGlm53Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'off':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return 'high'
  }
}

/** Kimi K2.6 / MiMo：只有开关，没有中间档。 */
function normalizeToggleLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  return level === 'off' ? 'off' : 'high'
}

/** Kimi K2.7 Code：思考强制开启，任何输入都落到唯一的「开」。 */
function normalizeAlwaysOnLevel(_level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  return 'high'
}

function normalizeQwen38Level(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    default:
      return 'high'
  }
}

function normalizeOpenAIStandardLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'off') return 'off'
  if (level === 'minimal') return 'low'
  if (level === 'max') return 'xhigh'
  return level ?? 'high'
}

function normalizeOpenAIMaxLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  if (level === 'minimal') return 'low'
  return level ?? 'high'
}

const DEEPSEEK_V4_FLASH_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-flash',
  levels: DEEPSEEK_V4_FLASH_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_FLASH_EFFORT_MAP },
  },
}

const DEEPSEEK_V4_PRO_PROFILE: ReasoningProfile = {
  id: 'deepseek-v4-pro',
  levels: DEEPSEEK_V4_PRO_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeDeepSeekV4Level,
  encodings: {
    'anthropic-messages': { kind: 'deepseek-output-effort', effortMap: DEEPSEEK_V4_PRO_EFFORT_MAP },
  },
}

const K3_PROFILE: ReasoningProfile = {
  id: 'kimi-k3',
  levels: K3_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeK3Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: K3_EFFORT_MAP },
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: K3_EFFORT_MAP },
  },
}

/** Kimi K2.6：thinking 开关；具体请求格式沿用 catalog 的 thinkingFormat=deepseek。 */
const KIMI_K2_6_PROFILE: ReasoningProfile = {
  id: 'kimi-k2.6-toggle',
  levels: KIMI_K2_6_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeToggleLevel,
  encodings: {
    'anthropic-messages': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
    'openai-completions': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
  },
}

/** Kimi K2.7 Code：思考强制开启，只接受 thinking.type=enabled。 */
const KIMI_K2_7_PROFILE: ReasoningProfile = {
  id: 'kimi-k2.7-always-on',
  levels: KIMI_K2_7_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeAlwaysOnLevel,
  encodings: {
    'anthropic-messages': { kind: 'provider-toggle', effortMap: THINKING_ALWAYS_ON_LEVEL_MAP },
    'openai-completions': { kind: 'provider-toggle', effortMap: THINKING_ALWAYS_ON_LEVEL_MAP },
  },
}

const GLM_53_PROFILE: ReasoningProfile = {
  id: 'glm-5.3',
  levels: GLM_53_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm53Level,
  encodings: {
    'anthropic-messages': { kind: 'anthropic-manual', effortMap: GLM_53_THINKING_LEVEL_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_53_THINKING_LEVEL_MAP },
  },
}

/** Qwen3.8 起 reasoning_effort 为 low / medium / xhigh，思考仍可关闭。 */
const QWEN_38_PROFILE: ReasoningProfile = {
  id: 'qwen-3.8',
  levels: QWEN_38_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeQwen38Level,
  encodings: {
    'openai-completions': { kind: 'qwen-thinking-effort', effortMap: QWEN_38_EFFORT_MAP },
  },
}

/** 小米 MiMo V2.5+：thinking.type 开关，没有 effort 档位。 */
const MIMO_PROFILE: ReasoningProfile = {
  id: 'mimo-toggle',
  levels: TOGGLE_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeToggleLevel,
  encodings: {
    'openai-completions': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
  },
}

const GLM_52_PROFILE: ReasoningProfile = {
  id: 'glm-5.2',
  levels: GLM_52_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeGlm52Level,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: GLM_52_ANTHROPIC_EFFORT_MAP },
    'openai-completions': { kind: 'zai-thinking-effort', effortMap: GLM_52_OPENAI_EFFORT_MAP },
  },
}

const GROK_46_PROFILE: ReasoningProfile = {
  id: 'grok-4.6',
  levels: GROK_46_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: GROK_46_EFFORT_MAP },
  },
}

const GROK_45_PROFILE: ReasoningProfile = {
  id: 'grok-4.5',
  levels: GROK_45_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: GROK_45_EFFORT_MAP },
  },
}

const GROK_43_PROFILE: ReasoningProfile = {
  id: 'grok-4.3',
  levels: GROK_43_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: GROK_43_EFFORT_MAP },
  },
}

/** 更早的 GLM（4.x / 5-turbo）：只有 thinking 开关。 */
const GLM_LEGACY_TOGGLE_PROFILE: ReasoningProfile = {
  id: 'glm-legacy-toggle',
  levels: TOGGLE_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeToggleLevel,
  encodings: {
    'anthropic-messages': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
    'openai-completions': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
  },
}

/** Qwen3.0–3.7：enable_thinking 开关，没有 effort。 */
const QWEN_TOGGLE_PROFILE: ReasoningProfile = {
  id: 'qwen-toggle',
  levels: TOGGLE_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeToggleLevel,
  encodings: {
    'openai-completions': { kind: 'provider-toggle', effortMap: THINKING_TOGGLE_LEVEL_MAP },
  },
}

const OPENAI_STANDARD_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-standard',
  levels: OPENAI_STANDARD_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIStandardLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_STANDARD_EFFORT_MAP },
  },
}

const OPENAI_GPT6_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]
// GPT-6 代际取消了 none / minimal：off 不产生参数，minimal 向上归到 low。
const OPENAI_GPT6_EFFORT_MAP = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies Record<AgentThinkingLevel, string | null>

const OPENAI_GPT6_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-gpt6',
  levels: OPENAI_GPT6_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_GPT6_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_GPT6_EFFORT_MAP },
  },
}

const OPENAI_MAX_PROFILE: ReasoningProfile = {
  id: 'openai-reasoning-max',
  levels: OPENAI_MAX_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeOpenAIMaxLevel,
  encodings: {
    'openai-completions': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
    'openai-responses': { kind: 'openai-reasoning-effort', effortMap: OPENAI_MAX_EFFORT_MAP },
  },
}

/**
 * Claude 5.x（含 Haiku/Sonnet/Opus/Fable）与 Opus 4.7/4.8 只接受 adaptive thinking。
 *
 * 判定逻辑在 reasoning-model-tag（家族 tag 的单一事实源），此处不再重复实现。
 */

const CLAUDE_ADAPTIVE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]

/**
 * Adaptive Claude 的档位映射。
 *
 * off 必须为 null：Pi 会因此省略 thinking 字段，而不是发送这些模型不接受的
 * `{ type: 'disabled' }`。xhigh 统一落到 max，因为原生 xhigh 只在部分型号可用，
 * 而 max 是所有 adaptive Claude 都支持的共同上限。
 */
const CLAUDE_ADAPTIVE_EFFORT_MAP: ReasoningEffortMap = {
  off: null,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

function normalizeClaudeAdaptiveLevel(level: AgentThinkingLevel | undefined): AgentThinkingLevel {
  return level ?? 'high'
}

const CLAUDE_ADAPTIVE_PROFILE: ReasoningProfile = {
  id: 'claude-adaptive',
  levels: CLAUDE_ADAPTIVE_LEVELS,
  defaultLevel: 'high',
  normalize: normalizeClaudeAdaptiveLevel,
  encodings: {
    'anthropic-messages': { kind: 'adaptive-effort', effortMap: CLAUDE_ADAPTIVE_EFFORT_MAP },
  },
}

export const REASONING_PROFILES: readonly ReasoningProfile[] = [
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
  K3_PROFILE,
  KIMI_K2_6_PROFILE,
  KIMI_K2_7_PROFILE,
  GLM_52_PROFILE,
  GLM_53_PROFILE,
  GLM_LEGACY_TOGGLE_PROFILE,
  GROK_43_PROFILE,
  GROK_45_PROFILE,
  GROK_46_PROFILE,
  QWEN_38_PROFILE,
  QWEN_TOGGLE_PROFILE,
  MIMO_PROFILE,
  OPENAI_STANDARD_PROFILE,
  OPENAI_MAX_PROFILE,
  OPENAI_GPT6_PROFILE,
  CLAUDE_ADAPTIVE_PROFILE,
]

/** 能力家族 tag → 档位 profile。同族不同 SKU 共用同一份档位语义。 */
const TAG_TO_PROFILE: Readonly<Record<ReasoningModelTag, ReasoningProfile>> = {
  'openai-gpt-5-standard': OPENAI_STANDARD_PROFILE,
  'openai-gpt-5-max': OPENAI_MAX_PROFILE,
  'openai-gpt-6': OPENAI_GPT6_PROFILE,
  'openai-o-series': OPENAI_STANDARD_PROFILE,
  'claude-adaptive': CLAUDE_ADAPTIVE_PROFILE,
  'deepseek-v4-flash': DEEPSEEK_V4_FLASH_PROFILE,
  'deepseek-v4-pro': DEEPSEEK_V4_PRO_PROFILE,
  'kimi-k3': K3_PROFILE,
  'kimi-k2-6-toggle': KIMI_K2_6_PROFILE,
  'kimi-k2-7-always-on': KIMI_K2_7_PROFILE,
  'glm-5.2': GLM_52_PROFILE,
  'glm-5.3': GLM_53_PROFILE,
  'glm-legacy-toggle': GLM_LEGACY_TOGGLE_PROFILE,
  'grok-4.3': GROK_43_PROFILE,
  'grok-4.5': GROK_45_PROFILE,
  'grok-4.6': GROK_46_PROFILE,
  'qwen-3.8': QWEN_38_PROFILE,
  'qwen-toggle': QWEN_TOGGLE_PROFILE,
  'mimo-toggle': MIMO_PROFILE,
}

/**
 * 解析模型当前 transport 的推理 profile。
 *
 * 先由 reasoning-model-tag 把模型 ID 归入能力家族（代际继承新 SKU），
 * 再用实际 transport 确认该家族有没有已验证的请求编码：
 * 同一模型在 Anthropic / OpenAI 两套端点上可用档位可以不同（如 Kimi K3）。
 * 未打标或该 transport 无编码时返回 undefined，由调用方回退到 Pi catalog。
 */
export function resolveReasoningProfile(input: ResolveReasoningProfileInput): ReasoningProfile | undefined {
  const tag = resolveReasoningModelTag(input.modelId)
  if (!tag) return undefined
  const profile = TAG_TO_PROFILE[tag]
  return profile.encodings[input.transport] ? profile : undefined
}

const PI_EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly AgentThinkingLevel[]

function getPiCatalogThinkingLevels(catalog: PiCatalogReasoningMetadata): AgentThinkingLevel[] {
  if (!catalog.reasoning) return []

  return PI_EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = catalog.thinkingLevelMap?.[level]
    if (mapped === null) return false
    // Pi only exposes these extended levels when the catalog maps them explicitly.
    return level !== 'xhigh' && level !== 'max' || mapped !== undefined
  })
}

/**
 * catalog 明确拒绝的档位。
 *
 * 只认 `thinkingLevelMap[level] === null` 这种显式声明，不把「缺省映射」当成不支持：
 * findPiCatalogModel 会跨 provider 兜底查同名模型，缺省映射可能只是这份目录没写全，
 * 用它否决经过验证的 profile 会把可用档位误删。`reasoning: false` 才是整体拒绝。
 */
function getCatalogDeniedLevels(catalog: PiCatalogReasoningMetadata | undefined): ReadonlySet<AgentThinkingLevel> {
  if (!catalog) return new Set()
  if (catalog.reasoning === false) return new Set(PI_EXTENDED_THINKING_LEVELS)
  const map = catalog.thinkingLevelMap
  if (!map) return new Set()
  return new Set(PI_EXTENDED_THINKING_LEVELS.filter((level) => map[level] === null))
}

/** capability 只描述真正可选的档位，effortMap 跟着档位一起收窄。 */
function narrowEffortMap(
  map: ReasoningEffortMap | undefined,
  levels: readonly AgentThinkingLevel[],
): ReasoningEffortMap | undefined {
  if (!map) return undefined
  const narrowed: ReasoningEffortMap = {}
  for (const level of levels) {
    if (level in map) narrowed[level] = map[level]
  }
  return Object.keys(narrowed).length > 0 ? narrowed : undefined
}

/**
 * 解析最终会话 capability。
 *
 * profile 决定「产品档位」（含经过验证的编码），catalog 只负责否决它显式标记为
 * 不支持的档位：两者取交集，避免同名模型换后端后界面仍给出会被服务端拒绝的档位。
 */
export function resolveReasoningCapability(input: ResolveReasoningCapabilityInput): ReasoningCapability | undefined {
  const denied = getCatalogDeniedLevels(input.catalog)

  if (input.profile) {
    const levels = input.profile.levels.filter((level) => !denied.has(level))
    if (levels.length === 0) return undefined
    const defaultLevel = normalizeReasoningCapabilityLevel(
      { source: 'profile', levels, defaultLevel: input.profile.defaultLevel },
      input.profile.defaultLevel,
    ) ?? levels[0]!
    return {
      source: 'profile',
      levels,
      defaultLevel,
      effortMap: narrowEffortMap(input.encoding?.effortMap, levels),
    }
  }

  if (!input.catalog) return undefined
  const levels = getPiCatalogThinkingLevels(input.catalog)
  if (levels.length === 0 || levels.every((level) => level === 'off')) return undefined
  const defaultLevel = normalizeReasoningCapabilityLevel(
    { source: 'pi-catalog', levels, defaultLevel: 'high' },
    'high',
  ) ?? levels[0]!

  // catalog 的 thinkingLevelMap 就是 Pi 的实际编码表，直接透出给界面。
  const effortMap: ReasoningEffortMap = {}
  for (const level of levels) {
    const mapped = input.catalog.thinkingLevelMap?.[level]
    if (typeof mapped === 'string') effortMap[level] = mapped
  }

  return {
    source: 'pi-catalog',
    levels,
    defaultLevel,
    ...(Object.keys(effortMap).length > 0 ? { effortMap } : {}),
  }
}

/**
 * 与 Pi `clampThinkingLevel` 保持一致：请求档位不可用时优先向更高档位靠拢，再向低档位回退。
 */
export function normalizeReasoningCapabilityLevel(
  capability: ReasoningCapability | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  if (!capability) return level
  const requested = level ?? capability.defaultLevel
  if (capability.levels.includes(requested)) return requested

  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(requested)
  if (requestedIndex === -1) return capability.levels[0]
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && capability.levels.includes(candidate)) return candidate
  }
  return capability.levels[0]
}

export function normalizeReasoningLevel(
  profile: ReasoningProfile | undefined,
  level: AgentThinkingLevel | undefined,
): AgentThinkingLevel | undefined {
  return profile ? profile.normalize(level) : level
}

/**
 * 把请求档位收敛到 profile 实际支持的档位（与 Pi clampThinkingLevel 同序：先向上、再向下）。
 *
 * 全局设置可能是上一个模型留下的档位（例如从 GPT-6 切到 GPT-5.5 时仍带 max），
 * 直接透传会发出服务端不接受的 effort。
 */
export function clampReasoningProfileLevel(
  profile: ReasoningProfile,
  level: AgentThinkingLevel,
): AgentThinkingLevel {
  if (profile.levels.includes(level)) return level
  const requestedIndex = PI_EXTENDED_THINKING_LEVELS.indexOf(level)
  if (requestedIndex === -1) return profile.defaultLevel
  for (let index = requestedIndex; index < PI_EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && profile.levels.includes(candidate)) return candidate
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_EXTENDED_THINKING_LEVELS[index]
    if (candidate && profile.levels.includes(candidate)) return candidate
  }
  return profile.defaultLevel
}

/**
 * 取某个 profile 在当前 transport 上「最低的非关闭档位」实际请求值。
 *
 * 标题生成这类辅助请求需要尽量便宜的思考：不能直接发 `none`，
 * 因为 GPT-6 / o 系列 / Grok 等服务端会拒绝该值；也不能发 `off`，
 * 因为部分模型（GPT-6、Grok、Kimi K3）根本不支持关闭思考。
 */
export function resolveLowestReasoningEffort(
  profile: ReasoningProfile | undefined,
  transport: ReasoningTransport,
): string | undefined {
  const encoding = profile?.encodings[transport]
  if (!profile || !encoding) return undefined
  for (const level of profile.levels) {
    if (level === 'off') continue
    const mapped = encoding.effortMap[level]
    if (typeof mapped === 'string') return mapped
  }
  return undefined
}

/**
 * 判断某 provider 是否可能支持推理档位（即可产出可渲染的思考块）。
 *
 * 主进程 resolvePiThinkingLevel 与 renderer 的思考档位菜单共用此判断，
 * 保证「能否选档位」与「能否真正发思考」保持一致。
 *
 * 这里不做模型级精确匹配：Pi SDK 会在建会话时用模型 catalog 的 thinking-level
 * 元数据 clamp 不支持的档位（对 reasoning:false 的模型安全忽略 thinkingLevel），
 * 而对 Anthropic 原生 extended thinking（anthropic/kimi/minimax/xiaomi 等）由 Pi
 * 原生 thinkingLevel 参数直接控制，不经过 reasoning profile 的 effort 重写。
 * 因此只需排除无 reasoning 协议的 transport（如 google）即可。
 */
export function supportsReasoningLevel(provider: ProviderType | undefined): boolean {
  return inferReasoningTransport(provider) !== 'other'
}

/**
 * 自建 / 未识别渠道兜底：模型 ID 形如官方 OpenAI 推理模型的（gpt-*、codex、o3/o4…）
 * 即使走 Completions 或 Anthropic 兼容层，reasoning 仍是自动摘要。
 */
const OPENAI_SUMMARY_MODEL_PATTERN = /(^|[^a-z0-9])(gpt-|codex|o[1-9]-)/i

/**
 * Pi 内核下 reasoning 只回「自动生成的概览摘要」的渠道族。
 *
 * OpenAI / Codex 系（含 ChatGPT 后端与代管 relay）与 xAI 都不暴露思维链正文，只给
 * summary：实体经验是大量 40～150 字的粗体标题，当思考面板没有信息量。
 *
 * 这里不用 `inferReasoningTransport`：它把 provider `openai` 归到 `openai-completions`
 * （为的是请求参数编码），而官方 OpenAI 渠道实际跑的是 Codex / Responses 后端，
 * 回的就是摘要——用协议推断会把 GPT 误判成可读 CoT。
 */
const SUMMARY_ONLY_REASONING_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai',
  'openai-codex',
  'openai-responses',
  'opencode-go-openai',
  'xai',
])

/**
 * Pi 内核下该模型的 thinking 是否只有「自动生成的概览摘要」。
 *
 * 判据是模型族，不是内核本身：DeepSeek / Kimi / GLM / Qwen 等经 Anthropic 兼容或
 * Completions 端点回的是完整可读思维链，应当展示。
 */
export function isSummaryOnlyPiReasoning(provider: ProviderType | undefined, modelId: string | undefined): boolean {
  if (provider !== undefined && SUMMARY_ONLY_REASONING_PROVIDERS.has(provider)) return true
  // 第三方网关可能用 Completions 承载官方 GPT 模型，此时 reasoning 依然只是摘要。
  if (provider === 'custom' || provider === undefined) {
    return typeof modelId === 'string' && OPENAI_SUMMARY_MODEL_PATTERN.test(modelId)
  }
  return false
}

export interface AgentThinkingVisibilityInput {
  /** 当前会话的 Agent 内核；缺省按非 Pi 处理（Claude 内核的 thinking 始终可读）。 */
  agentRuntime?: AgentRuntimeMode
  /** 模型所属渠道供应商；未知时按模型 ID 兜底判断。 */
  provider?: ProviderType
  modelId?: string
}

/**
 * 决定消息区是否渲染模型的 thinking 块。
 *
 * 历史实现是 `agentRuntime !== 'pi'`：它把「内核」当成了「模型能力」，在 Pi 内核只承载
 * GPT/Codex 的年代等价于「GPT 不展示摘要」，但 Pi 后来接管了 deepseek / kimi / GLM / qwen
 * 等可读 CoT 模型，一刀切会让这些模型的思考被整轮折叠进「执行过程」而看不到。
 * 现在按模型实际返回的 reasoning 形态判定。
 */
export function shouldShowAgentThinking(input: AgentThinkingVisibilityInput): boolean {
  if (input.agentRuntime !== 'pi') return true
  return !isSummaryOnlyPiReasoning(input.provider, input.modelId)
}
