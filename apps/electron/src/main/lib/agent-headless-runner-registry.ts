/**
 * Agent Headless Runner 注册表
 *
 * 解耦主进程内置工具与 AgentOrchestrator，避免循环依赖。
 * Agent service 将 headless runner、AgentOrchestrator 将 stopper 注入本注册表，
 * 其余模块（如协作工具、桥接命令）通过注册表间接调用。
 */

import type { AgentEndReason, AgentMessage, AgentSendInput, AgentExternalRunSource } from '@profer/shared'
import { DELEGATION_CANCELLED_RESULT_SUBTYPE } from './agent-end-reason'

/** 仅直接由 UI / IPC 发起的停止才属于 user。 */
export type AgentStopSource = 'user' | 'delegation_cancel'

export interface HeadlessAgentCompletionOptions {
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
  resultSubtype?: string
} {
  return source === 'delegation_cancel'
    ? { stoppedByUser: false, resultSubtype: DELEGATION_CANCELLED_RESULT_SUBTYPE }
    : { stoppedByUser: source === 'user' }
}

/**
 * headless completion 的单一路由：先告知调用方做协作记录收尾，再无条件转发同一完整 payload。
 * 调用方即使因 delegation 已预标终态而跳过自身收尾，也不能阻断 renderer completion。
 */
export function forwardHeadlessAgentCompletion(input: {
  callbacks: HeadlessAgentRunCallbacks
  messages?: AgentMessage[]
  opts?: HeadlessAgentCompletionOptions
  forwardToRenderer: (messages?: AgentMessage[], opts?: HeadlessAgentCompletionOptions) => void
}): void {
  input.callbacks.onComplete(input.messages, input.opts)
  input.forwardToRenderer(input.messages, input.opts)
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
