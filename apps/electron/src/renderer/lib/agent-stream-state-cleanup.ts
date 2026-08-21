import type { AgentStreamState } from '@/atoms/agent-atoms'

/**
 * 判断终态事件是否仍属于当前 run。旧 run 的 completion 不能触发通知、标记或关闭新 run。
 */
export function isCurrentAgentStreamCompletion(
  state: AgentStreamState | undefined,
  completion: { startedAt?: number },
): state is AgentStreamState {
  if (!state || (!state.running && !state.backgroundWaiting)) return false
  return state.startedAt == null || (completion.startedAt != null && state.startedAt <= completion.startedAt)
}

/**
 * 主进程确认一轮 run 已真实结束后，将 renderer 状态收敛到可继续输入的终态。
 * 错误消息、result 等 SDK 事件都不能代替 STREAM_COMPLETE 调用此函数，因为它们可能
 * 早于 orchestrator owner finally 到达；只有 STREAM_COMPLETE 才代表主进程运行锁已释放。
 */
export function settleCompletedAgentStreamState(
  state: AgentStreamState,
  backgroundTasksPending: boolean,
): AgentStreamState {
  const hasUnfinishedTools = state.toolActivities.some((activity) => !activity.done)
  return {
    ...state,
    running: false,
    backgroundWaiting: backgroundTasksPending,
    stopping: false,
    // compact_boundary 并非所有失败路径都会出现。任何真实终态都必须释放压缩 UI 锁，
    // 否则输入和后续压缩会被永久禁用。
    isCompacting: false,
    compactInFlight: false,
    toolActivities: hasUnfinishedTools
      ? state.toolActivities.map((activity) => activity.done ? activity : { ...activity, done: true })
      : state.toolActivities,
  }
}

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
