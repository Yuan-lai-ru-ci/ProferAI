/**
 * Agent Headless Runner 注册表
 *
 * 解耦主进程内置工具与 AgentOrchestrator，避免循环依赖。
 * AgentOrchestrator 启动时将 runner/stoper 注入本注册表，
 * 其余模块（如协作工具、桥接命令）通过注册表间接调用。
 */

import type { AgentMessage, AgentSendInput, AgentExternalRunSource } from '@profer/shared'

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (updatedTitle: string) => void
  source?: AgentExternalRunSource
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
) => Promise<void>

export type AgentStopper = (sessionId: string) => void

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

export function stopRegisteredAgent(sessionId: string): void {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  agentStopper(sessionId)
}
