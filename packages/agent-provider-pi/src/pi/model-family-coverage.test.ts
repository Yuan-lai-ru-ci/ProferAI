/**
 * 模型家族 tag 覆盖回归。
 *
 * 历史 bug：推理档位靠 `resolveReasoningProfile` 里的型号硬编码匹配，官方一发同族新 SKU
 * （gpt-6.1-sol、glm-5.3-flash、kimi-k3.1-pro、grok-4.7）就静默落到「无 profile」分支：
 * 界面退回 Claude 的 low/medium/high/max，运行时也不再注入 reasoning 参数。
 *
 * 这里直接读 Pi catalog（Profer 实际使用的模型元数据），断言所有「已纳入代际规则的家族」
 * 中的推理模型都能被 tag 命中；新增 SKU 不再需要逐个人工补 profile。
 * 未纳入的家族（MiniMax 等）保持 catalog 驱动，不在本测试范围内。
 */

import { describe, expect, test } from 'bun:test'
import { getModels } from '@earendil-works/pi-ai/compat'
import { resolveReasoningModelTag } from '@profer/shared'

/** Profer 通过 Pi catalog 注册过的 provider（含官方与 coding plan 目录）。 */
const CATALOG_PROVIDERS = [
  'openai',
  'openai-codex',
  'anthropic',
  'deepseek',
  'moonshotai',
  'moonshotai-cn',
  'kimi-coding',
  'zai',
  'zai-coding-cn',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-ams',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
] as const

/** 已建立代际规则的家族前缀：这些家族的新 SKU 必须自动继承档位。 */
const TAGGED_FAMILY_PREFIXES = ['gpt-', 'deepseek-', 'kimi-k', 'glm-', 'grok-', 'qwen', 'mimo-v'] as const

/**
 * 明确不参与档位 tag 的 SKU：
 * - gpt-realtime-*：实时语音模型，没有 chat 侧 reasoning effort
 * - deepseek-v3.2：V4 之前的世代，协议不同
 * - kimi-k2.5：官方已弃用
 */
const UNTAGGED_EXEMPTIONS = new Set([
  'gpt-realtime-2.1',
  'deepseek-v3.2',
  'kimi-k2.5',
])

describe('推理能力家族 tag 覆盖', () => {
  test('Given Pi catalog 中已建代际规则的家族 When 扫描推理模型 Then 每个 SKU 都能被 tag 命中', () => {
    const untagged: string[] = []

    for (const provider of CATALOG_PROVIDERS) {
      for (const model of getModels(provider)) {
        if (!model.reasoning) continue
        // -chat-latest 是纯对话变体，catalog 标了 reasoning 但不暴露档位。
        if (model.id.includes('chat-latest')) continue
        if (!TAGGED_FAMILY_PREFIXES.some((prefix) => model.id.startsWith(prefix))) continue
        if (UNTAGGED_EXEMPTIONS.has(model.id)) continue
        if (!resolveReasoningModelTag(model.id)) untagged.push(`${provider}:${model.id}`)
      }
    }

    expect(untagged).toEqual([])
  })
})
