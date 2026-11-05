/**
 * agent-stream-claim — 「切到某个 Agent 会话时是否要主动认领本轮流」的判定规则。
 *
 * 背景：建绑只发生在窗口挂载时，以及 run 启动时对主窗口的绑定；切 Tab 不会重新绑定。
 * 一旦该会话的流被别的窗口接管、或 run 由移动端发起而事件进了别处，本窗口就永远没有
 * 运行态，页面表现成「子会话没有 runtime、过程区一直折叠、消息停在打开时的快照上」。
 *
 * 这里只做纯判定，副作用（向主进程请求重绑 + 回放）留在调用方，便于单测覆盖边界：
 * - 独立会话窗口不认领（它在挂载时已认领自己的会话，且主进程不允许跨窗口抢）；
 * - 只看 Agent 标签，预览/聊天标签没有 agent 流语义；
 * - 已经有运行态就不打扰；
 * - 同一会话每次挂载只认领一次，避免切来切去反复请求。
 */
export interface AgentStreamClaimInput {
  /** 当前活跃标签的类型 */
  tabType?: string | null
  /** 本窗口是否已持有该会话的运行态 */
  hasRunningState: boolean
  /** 本次挂载是否已经为该会话发起过认领 */
  alreadyClaimed: boolean
  /** 当前窗口是否为独立会话窗口 */
  standalone: boolean
}

export function shouldClaimAgentStream(input: AgentStreamClaimInput): boolean {
  if (input.standalone) return false
  if (input.tabType !== 'agent') return false
  if (input.hasRunningState) return false
  if (input.alreadyClaimed) return false
  return true
}
