/**
 * agent-run-state-reconcile — 用所属内核的权威结果校正渲染层残留的「运行中」。
 *
 * 背景：远程内核的流事件由主进程投影后发给渲染层；渲染层收到任何事件、只要该会话
 * 还没有流式状态，就会先建一个 `running: true` 的占位。若这条事件并不是「开跑」，
 * 占位就永远不会被终态事件熄灭，界面表现为一直「Agent Running」，而后台其实没干活。
 *
 * 校正规则只做一件事：内核说这个会话没在跑，就把残留的运行态收掉。
 * 停止流程中的状态交给停止流程自己收敛，避免打断用户刚点的停止。
 */
export interface StaleRunStateInput {
  /** 渲染层当前是否显示为运行中 */
  running: boolean
  /** 是否处于「正在停止」流程 */
  stopping: boolean
  /** 所属内核是否真的持有该会话的运行 */
  coreActive: boolean
}

export function shouldClearStaleRunState(input: StaleRunStateInput): boolean {
  if (input.coreActive) return false
  if (input.stopping) return false
  return input.running
}
