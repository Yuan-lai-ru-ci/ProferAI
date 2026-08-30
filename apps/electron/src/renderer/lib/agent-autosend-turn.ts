/**
 * auto-send「轮结束」信号决策（纯函数，可单测）。
 *
 * 轮结束事件用「版本号」表示：每次 Agent 一轮运行结束（running 下降沿）turnVersion +1；
 * consumedVersion 记录已消费的版本。决策保证轮结束信号不会因「队列空/开关关/停止」等
 * 无法发送的场景残留为陈旧信号，之后开关/入队不会误触发。
 */

export type AutoSendTurnDecision = 'send' | 'defer' | 'consume' | 'idle'

/** 用户刚开启自动发送后，空闲队列是否已具备立即启动队首的条件。 */
export function shouldStartAutoSendFromIdle(state: {
  autoSendEnabled: boolean
  autoSendRequested: boolean
  queuedCount: number
  liveMessagesPending: boolean
  streaming: boolean
  canSendQueuedNow: boolean
}): boolean {
  return state.autoSendEnabled &&
    state.autoSendRequested &&
    state.queuedCount > 0 &&
    !state.liveMessagesPending &&
    !state.streaming &&
    state.canSendQueuedNow
}

export interface AutoSendTurnState {
  /** 轮结束版本号（running 下降沿 +1） */
  turnVersion: number
  /** 已消费版本号 */
  consumedVersion: number
  autoSendEnabled: boolean
  /** 当前队列消息数 */
  queuedCount: number
  /** live 消息未清空（上一轮执行还在 live，需等进入 persisted 再发） */
  liveMessagesPending: boolean
  streaming: boolean
  stoppedByUser: boolean
  canSendQueuedNow: boolean
}

export function evaluateAutoSendTurn(state: AutoSendTurnState): AutoSendTurnDecision {
  // 开关关：本轮结束无 auto-send 机会，消费版本号（防止陈旧信号）
  if (!state.autoSendEnabled) return 'consume'
  // 没有未消费的轮结束事件：空闲会话是否立即发送由 handleToggleAutoSend 负责，
  // 避免仅因入队触发旧的轮结束信号。
  if (state.consumedVersion >= state.turnVersion) return 'idle'
  // live 未清空：暂时等待（不消费，等下次 effect 重跑）
  if (state.liveMessagesPending) return 'defer'
  // 队列空：本轮结束无可发送队首，消费版本号（防止陈旧信号）
  if (state.queuedCount === 0) return 'consume'
  // 停止 / 正在运行 / 不可发送：本轮结束的发送机会已过，消费版本号
  if (state.streaming || state.stoppedByUser || !state.canSendQueuedNow) return 'consume'
  // 满足全部条件：发送队首
  return 'send'
}
