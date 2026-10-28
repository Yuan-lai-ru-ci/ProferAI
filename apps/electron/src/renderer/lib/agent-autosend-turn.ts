/**
 * 队列自动发送判定（纯函数，可单测）。
 *
 * 相对旧实现（v1.6.x）的改动：**去掉「轮结束版本号」**。
 *
 * 旧实现用「running 下降沿 +1、消费一次就作废」的一次性信号决定何时发队首，
 * 任何一次 gate 失败（live 未清空 / 正在压缩 / 被停止）都会把这次机会耗掉，
 * 之后只能等下一轮结束——表现为「队列消息再也不自动发送」（D3）。
 *
 * 新实现是纯条件判定 + 失败退避：
 * - 只要「队列非空 + 开关开 + 空闲可发」就发，不依赖任何一次性信号，天然幂等；
 * - 发送失败回队首并记录时间戳，退避窗口内不再重试，避免 tight loop；
 * - 空闲时队列新增/恢复同样满足条件，压缩后也能自己续跑。
 */

export interface AutoSendGateState {
  /** 该会话「自动发送」开关（meta 持久化，缺省开） */
  autoSendEnabled: boolean
  queuedCount: number
  /** 上一轮的 live 消息还没进 persisted，此时发会重复渲染 */
  liveMessagesPending: boolean
  streaming: boolean
  stoppedByUser: boolean
  /** 渠道/模型/权限弹窗等硬前置是否满足 */
  canSendQueuedNow: boolean
  /** 已有队列消息在飞行中 */
  sendInFlight: boolean
  /** 上次自动发送失败的时间戳；0 表示本次会话还没失败过 */
  lastFailureAt: number
  now: number
  /** 失败退避窗口，默认 3000ms */
  retryIntervalMs?: number
}

export const AUTO_SEND_RETRY_INTERVAL_MS = 3000

export function shouldAutoSendQueueHead(state: AutoSendGateState): boolean {
  if (!state.autoSendEnabled) return false
  if (state.queuedCount <= 0) return false
  if (state.streaming || state.liveMessagesPending || state.stoppedByUser) return false
  if (!state.canSendQueuedNow || state.sendInFlight) return false
  const retryInterval = state.retryIntervalMs ?? AUTO_SEND_RETRY_INTERVAL_MS
  if (state.lastFailureAt > 0 && state.now - state.lastFailureAt < retryInterval) return false
  return true
}

/** 自动发送失败后的下一次重试时间；未失败过返回 0。 */
export function nextAutoSendRetryAt(state: Pick<AutoSendGateState, 'lastFailureAt' | 'retryIntervalMs'>): number {
  if (state.lastFailureAt <= 0) return 0
  return state.lastFailureAt + (state.retryIntervalMs ?? AUTO_SEND_RETRY_INTERVAL_MS)
}
