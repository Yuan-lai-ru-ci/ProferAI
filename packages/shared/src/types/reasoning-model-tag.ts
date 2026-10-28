/**
 * 模型 ID → 推理能力家族 tag（推理档位的「打标」层）。
 *
 * 背景：旧实现把型号逐个写进 resolveReasoningProfile 的三元表达式里
 * （`gpt-5` 前缀 / `gpt-6-astra` 精确匹配 / `glm-5.3` 精确匹配 …），
 * 一旦官方发布同族新 SKU（gpt-6.1-sol、glm-5.3-flash、kimi-k3.1-pro、
 * grok-4.7），就会静默落到「无 profile」分支：界面退回 Claude 的
 * low/medium/high/max，运行时也不再注入任何 reasoning 参数。
 *
 * 本模块把「哪些模型属于哪个能力家族」收敛成一张按代际继承的规则表：
 *   - 每个家族只声明「进入该 tag 的最低版本」，同族更高版本（含未来新 SKU）自动继承；
 *   - 变体后缀（-highspeed / -flash / -pro / -mini / -codex / -sol …）不参与版本比较；
 *   - 非推理型号（-chat-latest、gpt-4 系）显式排除，避免被家族前缀误伤。
 *
 * 这里只回答「属于哪个能力家族」，具体档位与请求编码在 reasoning-profile 里定义。
 */

import { normalizeModelIdTail, resolveDeepSeekV4ModelId } from './deepseek-model-alias'
import { extractVersionAfterPrefix, isVersionAtLeast, parseVersionSegments } from '../utils/model-version'

/**
 * 推理能力家族 tag。
 *
 * 同一个 tag 可以覆盖多个 SKU：档位语义相同的型号共用一个 tag，
 * 差异（上下文、价格、输出上限）由 model-registry 的 SKU 元数据表达。
 */
export type ReasoningModelTag =
  | 'openai-gpt-5-standard'
  | 'openai-gpt-5-max'
  | 'openai-gpt-6'
  | 'openai-o-series'
  | 'claude-adaptive'
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'kimi-k3'
  | 'kimi-k2-6-toggle'
  | 'kimi-k2-7-always-on'
  | 'glm-5.2'
  | 'glm-5.3'
  | 'glm-legacy-toggle'
  | 'grok-4.3'
  | 'grok-4.5'
  | 'grok-4.6'
  | 'qwen-3.8'
  | 'qwen-toggle'
  | 'mimo-toggle'

export interface ReasoningModelTagRule {
  tag: ReasoningModelTag
  /** 自定义匹配；提供时忽略 prefix/minVersion/exact/shortNames。 */
  match?: (modelId: string) => boolean
  /** 家族前缀；前缀之后的数字段参与版本比较。 */
  prefix?: string
  /** 进入该 tag 的最低版本，如 '5.6'；'.' 与 '-' 等价。 */
  minVersion?: string
  /** 不带版本号的官方短名；按前缀匹配，同代变体自动继承。 */
  shortNames?: readonly string[]
  /** 同族中不属于该 tag 的 SKU（如非推理的 -chat-latest）。 */
  exclude?: (modelId: string) => boolean
}

/** 只提供对话、不提供 reasoning 的 SKU（`gpt-5-chat-latest` 等）。 */
function isChatOnlyModel(modelId: string): boolean {
  return modelId.includes('chat-latest')
}

/**
 * Claude adaptive thinking 家族。
 *
 * Anthropic 对 Claude 5.x（Haiku/Sonnet/Opus/Fable）与 Opus 4.7/4.8 发送旧版
 * `{ type: 'enabled', budget_tokens }` 会直接 400：这些型号只接受 adaptive。
 * 旧版 Claude 4.5 及以下仍走 manual，不能误伤。
 */
export function isClaudeAdaptiveThinkingModel(modelId: string): boolean {
  // 中转站常把模型写成 `anthropic/claude-haiku-5-5` 这类带 provider 前缀的 ID；
  // 能力判定只看模型族，不能因为前缀漏掉 adaptive 要求。
  const normalized = modelId.trim().toLowerCase()
  const id = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  if (!id.startsWith('claude-')) return false
  if (id.startsWith('claude-mythos-preview')) return true
  // claude-<family>-5...：fable / haiku / opus / sonnet 的 5.x 代际。
  if (/^claude-[a-z]+-5(?:-|$)/.test(id)) return true
  // Opus 4.7 / 4.8 已切到 adaptive-only。
  if (/^claude-opus-4-(?:7|8)(?:-|$)/.test(id)) return true
  return false
}

/**
 * 家族规则表：顺序即优先级，同前缀的更高代际必须排在前面。
 *
 * 版本阈值来自各厂商官方文档（见 docs/plans/2026-10-27-model-reasoning-capability-matrix.md）：
 * - GPT-5 起才有 reasoning.effort；5.6 起支持 max；GPT-6 起取消 none/minimal
 * - Kimi K3 起改为顶层 reasoning_effort（K2.x 仍是 thinking 开关）
 * - GLM-5.2 起支持 reasoning_effort（5.3 起取消关闭思考）
 * - Grok 4.6 起支持 xhigh
 * - Qwen3.8 起 reasoning_effort 为 low/medium/xhigh
 * - MiMo V2.5 只有 thinking 开关
 */
export const REASONING_MODEL_TAG_RULES: readonly ReasoningModelTagRule[] = [
  // ===== OpenAI GPT =====
  // GPT-6 代际：effort 只剩 low/medium/high/xhigh/max（none 与 minimal 被移除）。
  { tag: 'openai-gpt-6', prefix: 'gpt-', minVersion: '6', exclude: isChatOnlyModel },
  // GPT-5.6 起新增 max。
  { tag: 'openai-gpt-5-max', prefix: 'gpt-', minVersion: '5.6', exclude: isChatOnlyModel },
  // GPT-5.0–5.5：off/low/medium/high/xhigh（具体可用档位由 catalog 再收窄）。
  { tag: 'openai-gpt-5-standard', prefix: 'gpt-', minVersion: '5', exclude: isChatOnlyModel },
  // o1/o3/o4 系列（含 -pro/-mini）：只有 low/medium/high，由 catalog 收窄。
  { tag: 'openai-o-series', match: (modelId) => /^o[1-9](?:-|$)/.test(modelId) },

  // ===== Anthropic =====
  { tag: 'claude-adaptive', match: (modelId) => isClaudeAdaptiveThinkingModel(modelId) },

  // ===== DeepSeek（先归一旧写法与官方短名） =====
  // 带日期后缀的同代变体（deepseek-v4-flash-0731）也归入 flash；
  // deepseek-v4.1-flash 是 flash 的带版本号写法（同一 SKU）。
  { tag: 'deepseek-v4-flash', shortNames: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash'] },
  { tag: 'deepseek-v4-pro', shortNames: ['deepseek-v4-pro'] },

  // ===== Kimi =====
  // K3 代际（K3 / K3-256K / K3.1 Pro / kimi-for-coding）：顶层 reasoning_effort。
  // 前缀只写到 kimi-k，让 3.0 / 3.1 都参与版本比较。
  { tag: 'kimi-k3', prefix: 'kimi-k', minVersion: '3' },
  { tag: 'kimi-k3', shortNames: ['k3', 'kimi-for-coding'] },
  // K2.7 Code：思考强制开启，只接受 thinking.type=enabled。
  { tag: 'kimi-k2-7-always-on', shortNames: ['kimi-k2.7'] },
  // K2.6：thinking 开关（可关闭）。
  { tag: 'kimi-k2-6-toggle', shortNames: ['kimi-k2.6'] },

  // ===== 智谱 GLM =====
  // 5.3 起思考强制开启，reasoning_effort 为 low/high/max。
  { tag: 'glm-5.3', prefix: 'glm-', minVersion: '5.3' },
  // 5.2 代际：high/max，可关闭思考。
  { tag: 'glm-5.2', prefix: 'glm-', minVersion: '5.2' },
  // 更早的 GLM（4.x / 5-turbo）：只有 thinking 开关，没有 effort。
  { tag: 'glm-legacy-toggle', prefix: 'glm-', exclude: (modelId) => modelId.includes('preview') },

  // ===== xAI =====
  // 4.6 起支持 xhigh；思考始终开启。
  { tag: 'grok-4.6', prefix: 'grok-', minVersion: '4.6' },
  // 4.5：最高只到 high；思考始终开启。
  { tag: 'grok-4.5', prefix: 'grok-', minVersion: '4.5' },
  // 4.3：可关闭思考，最高只到 high。
  { tag: 'grok-4.3', prefix: 'grok-', minVersion: '4.3' },

  // ===== 阿里 Qwen =====
  // 3.8 起 reasoning_effort 为 low/medium/xhigh（更早的 3.x 只有开关）。
  { tag: 'qwen-3.8', prefix: 'qwen', minVersion: '3.8' },
  // 3.0–3.7：enable_thinking 开关。
  { tag: 'qwen-toggle', prefix: 'qwen', minVersion: '3' },

  // ===== 小米 MiMo =====
  // V2.5 起只有 thinking.type 开关，没有 effort 档位。
  { tag: 'mimo-toggle', prefix: 'mimo-v', minVersion: '2.5' },
]

function matchesRule(modelId: string, rule: ReasoningModelTagRule): boolean {
  if (rule.match) return rule.match(modelId)
  if (rule.exclude?.(modelId)) return false
  if (rule.shortNames?.some((shortName) => modelId.startsWith(shortName))) return true
  if (!rule.prefix || !modelId.startsWith(rule.prefix)) return false
  if (!rule.minVersion) return true
  return isVersionAtLeast(
    extractVersionAfterPrefix(modelId, rule.prefix),
    parseVersionSegments(rule.minVersion),
  )
}

/**
 * 解析模型的推理能力家族 tag。
 *
 * 返回 undefined 表示「不属于任何已验证家族」：调用方应回退到 Pi catalog 元数据，
 * 而不是猜一套档位。带网关前缀（`openrouter/moonshotai/kimi-k3`）与 `[1m]`
 * 后缀的写法会先归一，保证同一模型不会因写法不同而丢档位。
 */
export function resolveReasoningModelTag(modelId?: string): ReasoningModelTag | undefined {
  const normalized = normalizeModelIdTail(modelId)
  if (!normalized) return undefined

  // DeepSeek 的历史写法 / 官方短名先归一（deepseek-v4-flash → deepseek-flash），
  // 否则同一个模型会因写法不同落到不同分支。
  const model = resolveDeepSeekV4ModelId(normalized) ?? normalized
  for (const rule of REASONING_MODEL_TAG_RULES) {
    if (matchesRule(model, rule)) return rule.tag
  }
  return undefined
}
