/**
 * Agent Headless Runner 注册表
 *
 * 解耦主进程内置工具与 AgentOrchestrator，避免循环依赖。
 * Agent service 将 headless runner、AgentOrchestrator 将 stopper 注入本注册表，
 * 其余模块（如协作工具、桥接命令）通过注册表间接调用。
 */

import type { AgentEndReason, AgentMessage, AgentSendInput, AgentExternalRunSource } from '@profer/shared'

/** 仅直接由 UI / IPC 发起的停止才属于 user。 */
export type AgentStopSource = 'user' | 'delegation_cancel' | 'parent_cancel'

export interface HeadlessAgentCompletionOptions {
  runId?: string
  eventId?: string
  stopReason?: string
  outcomeStatus?: 'completed' | 'failed' | 'stopped'
  persistence?: import('@profer/agent-runtime').RuntimePersistenceState
  /** messages 仅当前 run，不是全历史。缺省保持旧调用语义。 */
  messagesScope?: 'run'
  stoppedByUser?: boolean
  startedAt?: number
  resultSubtype?: string
  resultErrors?: string[]
  backgroundTasksPending?: boolean
  endReason?: AgentEndReason
  endReasonLabel?: string
}

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[], opts?: HeadlessAgentCompletionOptions) => void
  onTitleUpdated: (updatedTitle: string) => void
  source?: AgentExternalRunSource
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
) => Promise<void>

export type AgentStopper = (sessionId: string, source?: AgentStopSource) => void

/** 将停止来源转换为统一终态字段，供所有 orchestrator 终态出口复用。 */
export function getAgentStopCompletionOptions(source: AgentStopSource | undefined): {
  stoppedByUser: boolean
  stopReason?: string
} {
  if (source === 'delegation_cancel' || source === 'parent_cancel') return { stoppedByUser: false, stopReason: source }
  return { stoppedByUser: source === 'user' }
}

/**
 * headless completion 的单一路由：先告知调用方做协作记录收尾，再无条件转发同一完整 payload。
 * 调用方即使因 delegation 已预标终态而跳过自身收尾，也不能阻断 renderer completion。
 */
export interface ForwardHeadlessAgentCompletionInput {
  callbacks: HeadlessAgentRunCallbacks
  messages?: AgentMessage[]
  opts?: HeadlessAgentCompletionOptions
  forwardToRenderer: (messages?: AgentMessage[], opts?: HeadlessAgentCompletionOptions) => void
}

export function forwardHeadlessAgentCompletion(input: ForwardHeadlessAgentCompletionInput): void {
  try {
    input.callbacks.onComplete(input.messages, input.opts)
  } finally {
    input.forwardToRenderer(input.messages, input.opts)
  }
}

/**
 * 终态转发的幂等闸门：同一轮 run 的**真实终态**只转发一次。
 *
 * 为什么不能简单地对 `forwardHeadlessAgentCompletion` 去重：
 * `backgroundTasksPending: true` 的「轻量完成」（编排层 `idleComplete`）会在同一轮内
 * 多次到达，它**不是**终态——UI 靠它进入「空闲可输入」态，去重会把后续续轮信号吞掉。
 * 因此这里只对**非后台任务**的终态做一次性保护：真实终态最多一次，轻量完成不限次。
 *
 * 复用 `forwardHeadlessAgentCompletion` 的既有 payload 语义，不改变其行为；
 * 返回 `false` 表示这次终态是重复投递，已被忽略。
 */
export function createHeadlessCompletionForwarder(): (
  input: ForwardHeadlessAgentCompletionInput,
) => boolean {
  let terminalDelivered = false
  return (input) => {
    const backgroundTasksPending = input.opts?.backgroundTasksPending === true
    if (!backgroundTasksPending) {
      if (terminalDelivered) return false
      terminalDelivered = true
    }
    forwardHeadlessAgentCompletion(input)
    return true
  }
}

let headlessRunner: HeadlessAgentRunner | null = null
let agentStopper: AgentStopper | null = null

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner): void {
  headlessRunner = runner
}

export function setAgentStopper(stopper: AgentStopper): void {
  agentStopper = stopper
}

export async function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
): Promise<void> {
  if (!headlessRunner) {
    throw new Error('Agent headless runner 尚未初始化')
  }
  return headlessRunner(input, callbacks)
}

export function stopRegisteredAgent(sessionId: string, source: AgentStopSource = 'user'): void {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  agentStopper(sessionId, source)
}
