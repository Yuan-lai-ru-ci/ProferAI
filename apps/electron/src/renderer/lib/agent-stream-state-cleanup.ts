import type { AgentStreamState } from '@/atoms/agent-atoms'

/**
 * 释放后台已完成会话的瞬时流式状态，同时保留上下文用量展示需要的数据。
 * 运行中或后台任务软空闲状态必须原样保留，避免陈旧完成事件破坏新一轮执行。
 */
export function compactCompletedBackgroundStreamState(
  state: AgentStreamState | undefined,
): AgentStreamState | undefined {
  if (!state || state.running || state.backgroundWaiting) return state

  if (state.inputTokens === undefined) return undefined

  return {
    running: false,
    content: '',
    toolActivities: [],
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheCreationTokens: state.cacheCreationTokens,
    contextWindow: state.contextWindow,
    model: state.model,
  }
}
