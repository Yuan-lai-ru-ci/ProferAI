import { isGoalUpdateToolName } from '@profer/shared'
import type { SDKMessage, AgentGoalUsage } from '@profer/shared'

/** Goal 只读取当前轮 runtime usage；消息正文永远不能成为控制协议。 */
export function collectGoalRunUsage(messages: SDKMessage[]): AgentGoalUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; usage?: Record<string, unknown> }
    if (message.type !== 'result' || !message.usage) continue
    const value = (key: string) => {
      const number = Number(message.usage?.[key] ?? 0)
      return Number.isFinite(number) && number >= 0 ? number : 0
    }
    const inputTokens = value('input_tokens') + value('cache_read_input_tokens') + value('cache_creation_input_tokens')
    const outputTokens = value('output_tokens')
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
  }
  return undefined
}

export type GoalTurnProgress = 'progress' | 'empty' | 'all_tools_failed'

type ContentBlock = { type?: string; text?: string; name?: string; is_error?: boolean }

function contentBlocks(message: SDKMessage): ContentBlock[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? content as ContentBlock[] : []
}

/**
 * 依据本轮真实 runtime 消息判断有无进展（对齐 Codex 的空回复 / exec 全失败判定）。
 * Goal 内部 update_goal 工具不算工作进展。
 */
export function assessGoalTurnProgress(messages: SDKMessage[]): GoalTurnProgress {
  let hasText = false
  let toolCalls = 0
  let toolResults = 0
  let failedResults = 0
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (message.type === 'assistant' && block.type === 'text' && block.text?.trim()) hasText = true
      if (message.type === 'assistant' && block.type === 'tool_use' && !isGoalUpdateToolName(block.name)) toolCalls++
      if (message.type === 'user' && block.type === 'tool_result') {
        toolResults++
        if (block.is_error) failedResults++
      }
    }
  }
  if (toolCalls === 0) return hasText ? 'progress' : 'empty'
  return toolResults > 0 && failedResults === toolResults ? 'all_tools_failed' : 'progress'
}
