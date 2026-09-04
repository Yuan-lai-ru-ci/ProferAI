import type { SDKMessage } from '@profer/shared'

interface AgentRunningIndicatorState {
  streaming: boolean
  streamError?: string | null
  liveMessages?: readonly SDKMessage[]
}

/**
 * 终态错误卡与「Agent Running」必须互斥。
 *
 * STREAM_COMPLETE 仍是释放会话运行锁的唯一权威信号；此函数只控制视觉指示器，
 * 避免错误消息已经可见时计时器仍持续增长，误导用户认为 Agent 还在正常工作。
 */
export function shouldShowAgentRunningIndicator({
  streaming,
  streamError,
  liveMessages,
}: AgentRunningIndicatorState): boolean {
  if (!streaming || streamError) return false

  return !(liveMessages?.some((message) => {
    const record = message as Record<string, unknown>
    return record.type === 'assistant' && record.error != null
  }) ?? false)
}
