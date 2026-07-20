import type { ProviderType } from '@profer/shared'

export const DEEPSEEK_SUBAGENT_MODEL_ID = 'deepseek-v4-flash'
export interface AgentModelRoutingInput {
  modelId?: string
  provider?: ProviderType
}

export interface AgentModelRoutingPolicy {
  /** 是否命中 DeepSeek 系列主模型 */
  deepSeekFamily: boolean
  /** 是否为该 provider/model 组合启用 Anthropic 1M context beta */
  enable1MContext: boolean
  /** 命中时写入 CLAUDE_CODE_SUBAGENT_MODEL；未命中时删除该环境变量以保留 SDK 默认解析 */
  subagentModel?: string
}

/**
 * 解析 Agent 辅助模型路由策略。
 *
 * DeepSeek 系列主模型使用 deepseek-v4-flash 承担 SubAgent，避免复杂主模型
 * 被高频探索 / 审查子任务消耗；其它模型不写该变量，交回 SDK 按
 * per-invocation model、subagent frontmatter、主模型的顺序解析。
 */
export function resolveAgentModelRouting(input: AgentModelRoutingInput): AgentModelRoutingPolicy {
  const model = input.modelId?.trim().toLowerCase() ?? ''
  const deepSeekFamily = input.provider === 'deepseek' ||
    model.startsWith('deepseek-') ||
    model.includes('/deepseek-')

  return {
    deepSeekFamily,
    // DeepSeek 的 Anthropic-compatible endpoint 尚未确认支持 Claude 的 `[1m]`
    // 模型后缀和 `context-1m-2025-08-07` beta；不得擅自改变用户配置的模型 ID。
    enable1MContext: !deepSeekFamily,
    ...(deepSeekFamily && { subagentModel: DEEPSEEK_SUBAGENT_MODEL_ID }),
  }
}

export function applyAgentModelRoutingToEnv(
  env: Record<string, string | undefined>,
  policy: AgentModelRoutingPolicy,
): void {
  if (policy.subagentModel) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = policy.subagentModel
  } else {
    delete env.CLAUDE_CODE_SUBAGENT_MODEL
  }
}
