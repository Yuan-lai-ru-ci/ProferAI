/**
 * 队列「轮结束」信号决策（纯函数，可单测）。
 *
 * 轮结束事件用版本号表示：每次 Agent 一轮运行结束（running 下降沿）turnVersion +1；
 * consumedVersion 记录已消费的版本，队列消息始终自动按 FIFO 发送。
 */

export type AutoSendTurnDecision = 'send' | 'defer' | 'consume' | 'idle'

/** 队列在空闲会话中新增或恢复时，也必须立即启动队首。 */
export function shouldStartAutoSendFromIdle(state: {
  queuedCount: number
  liveMessagesPending: boolean
  streaming: boolean
  stoppedByUser: boolean
  canSendQueuedNow: boolean
}): boolean {
  return state.queuedCount > 0 &&
    !state.liveMessagesPending &&
    !state.streaming &&
    !state.stoppedByUser &&
    state.canSendQueuedNow
}

export interface AutoSendTurnState {
  /** 轮结束版本号（running 下降沿 +1） */
  turnVersion: number
  /** 已消费版本号 */
  consumedVersion: number
  /** 当前队列消息数 */
  queuedCount: number
  /** live 消息未清空（上一轮执行还在 live，需等进入 persisted 再发） */
  liveMessagesPending: boolean
  streaming: boolean
  stoppedByUser: boolean
  canSendQueuedNow: boolean
}

export function evaluateAutoSendTurn(state: AutoSendTurnState): AutoSendTurnDecision {
  // 没有未消费的轮结束事件：避免仅因入队触发旧的轮结束信号。
  if (state.consumedVersion >= state.turnVersion) return 'idle'
  // live 未清空：暂时等待（不消费，等下次 effect 重跑）。
  if (state.liveMessagesPending) return 'defer'
  // 队列空：本轮结束无可发送队首，消费版本号（防止陈旧信号）。
  if (state.queuedCount === 0) return 'consume'
  // 停止 / 正在运行 / 不可发送：本轮结束的发送机会已过，消费版本号。
  if (state.streaming || state.stoppedByUser || !state.canSendQueuedNow) return 'consume'
  // 满足全部条件：发送队首。
  return 'send'
}
