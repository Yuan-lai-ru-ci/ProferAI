/**
 * Agent 推理档位解析（#1268 GPT-5.x 推理档位跨会话记忆）
 *
 * 级联优先级（从高到低）：
 *   1. 会话级 openAIThinkingLevel（用户在此会话中手动选择）
 *   2. 全局 agentThinking 开关 → 关闭时返回 'off'
 *   3. 全局 agentEffort 设置 → 'low' / 'medium' / 'high' / 'xhigh'
 *   4. 默认值 'off'
 *
 * 注意：GPT-5.x 服务端默认 reasoning.effort = 'medium'。用户选择 "关闭推理" 时
 * 必须显式写入 reasoning: { effort: 'none' }，否则不会真正关闭。
 */

import type { AgentThinkingLevel } from '@profer/shared'

export interface ThinkingLevelSettings {
  /** 全局「思考模式」开关 */
  agentThinking?: boolean
  /** 全局思考投入程度 */
  agentEffort?: 'low' | 'medium' | 'high' | 'max'
}

/**
 * 解析最终推理档位。
 *
 * @param sessionThinkingLevel 会话级持久化选择（可跨会话记忆）
 * @param settings 全局应用设置
 * @param provider 当前 provider（仅 openai-codex 支持推理档位）
 */
export function resolvePiThinkingLevel(
  sessionThinkingLevel: AgentThinkingLevel | null | undefined,
  settings: ThinkingLevelSettings,
  provider?: string,
): AgentThinkingLevel {
  // 仅 ChatGPT Codex (OpenAI) 支持 reasoning.effort
  if (provider && provider !== 'openai-codex') return 'off'

  // 会话级手动选择（含显式 null 表示「使用全局默认」）
  if (sessionThinkingLevel === null || sessionThinkingLevel === undefined) {
    return resolveGlobalThinkingLevel(settings)
  }
  return sessionThinkingLevel
}

/**
 * 解析全局默认推理档位。
 */
export function resolveGlobalThinkingLevel(settings: ThinkingLevelSettings): AgentThinkingLevel {
  if (!settings.agentThinking) return 'off'

  switch (settings.agentEffort) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
      return 'xhigh'
    default:
      // agentThinking 开启但未设置 agentEffort → 默认 high
      return 'high'
  }
}
