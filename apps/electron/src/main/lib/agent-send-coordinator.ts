import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { validateAgentSendBinding } from './agent-send-binding'

type Dependencies = {
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  workspaceExists: (workspaceId: string) => boolean
  getChannel: (channelId: string) => Channel | undefined
  startMirror: (session: AgentSessionMeta) => Promise<void>
  /** 在任何 await 前占用会话；返回实际 Agent 生命周期 Promise。 */
  startAgent: () => Promise<void>
  onMirrorError: (error: unknown) => void
}

/** 在任何镜像或 Agent 副作用前执行可信绑定校验。 */
export async function coordinateAgentSend(input: AgentSendInput, deps: Dependencies): Promise<void> {
  const session = deps.getSession(input.sessionId)
  const workspaceExists = !session?.workspaceId || deps.workspaceExists(session.workspaceId)
  const binding = validateAgentSendBinding(input, session, workspaceExists, deps.getChannel(input.channelId))
  if (!binding.ok) throw new Error(`${binding.code}: ${binding.message}`)
  if (!session) throw new Error(`AGENT_SESSION_NOT_FOUND: Agent 会话不存在: ${input.sessionId}`)

  // 先同步启动编排器以原子占用 active session，再等待可能很慢的镜像初始化。
  // 这样 runtime 切换不会落在 mirror await 与实际 Agent 启动之间的空窗。
  const agentRun = deps.startAgent()
  await deps.startMirror(session).catch(deps.onMirrorError)
  await agentRun
}
