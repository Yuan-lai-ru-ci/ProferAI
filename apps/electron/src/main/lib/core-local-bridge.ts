import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { createAgentRunContext, type CredentialPort } from '@profer/agent-runtime'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { validateAgentSendBinding } from './agent-send-binding'
import { resolveCredentialPreflightTypedError } from './agent-preflight-typed-errors'
import type { CoreAgentEvent, CoreMessageOptions } from './core-client'
import { CoreClient } from './core-client'
import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS } from '@profer/shared'
import { projectRemoteRunEvent } from './core-run-projection'
import { invalidateWorkspaceLocation } from './workspace-locator'
import { configureCoreHostConnection } from './core-host-connection'

let publishLocal: (channel: string, payload?: unknown) => void = () => {}
/** 本机 Core 启动失败的原始原因；仅用于把“未就绪”变成可诊断的信息。 */
let localCoreStartFailure: string | null = null
export function setLocalCoreStartFailure(message: string | null): void { localCoreStartFailure = message }
export function getLocalCoreStartFailure(): string | null { return localCoreStartFailure }
export function setLocalCorePublisher(publish: typeof publishLocal): void { publishLocal = publish }

export type LocalCoreSessionEventHandler = (event: CoreAgentEvent) => void

let client: CoreClient | null = null
let unsubscribe: (() => void) | undefined
let unsubscribeSnapshot: (() => void) | undefined
let unsubscribeAutomation: (() => void) | undefined
let unsubscribeWorkspace: (() => void) | undefined
const handlers = new Map<string, LocalCoreSessionEventHandler>()
const activeSessions = new Set<string>()

export function attachLocalCoreClient(next: CoreClient): void {
  unsubscribe?.()
  unsubscribeSnapshot?.()
  unsubscribeAutomation?.()
  unsubscribeWorkspace?.()
  client = next
  configureCoreHostConnection(next, {
    contentRoot: join(app.getPath('temp'), 'profer-core-host'),
    sessionId: value => value,
    isCurrent: () => client === next,
    emitPreview: (sessionId, payload) => publishLocal(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload }),
  })
  const publish = (channel: string, payload?: unknown) => { if (client === next) publishLocal(channel, payload) }
  unsubscribe = next.addEventListener(event => {
    if (client !== next) return
    const payload = event.payload as { kind?: string; event?: { type?: string; state?: import('@profer/shared').AgentGoalState } }
    if (payload?.event?.type === 'runtime_started') activeSessions.add(event.sessionId)
    if (payload?.event?.type === 'run_completed') activeSessions.delete(event.sessionId)
    const handler = handlers.get(event.sessionId)
    if (handler) { handler(event); return }
    if (payload?.event?.type === 'goal_state') {
      publish(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: event.sessionId, state: payload.event.state?.reasonCode === 'cleared' ? null : payload.event.state })
      return
    }
    const projected = projectRemoteRunEvent(event, event.sessionId)
    if (projected?.eventPayload) publish(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: event.sessionId, payload: projected.eventPayload })
    if (projected?.completion) publish(AGENT_IPC_CHANNELS.STREAM_COMPLETE, projected.completion)
  })
  unsubscribeSnapshot = next.addSnapshotListener(snapshot => {
    if (client !== next) return
    activeSessions.clear()
    for (const run of snapshot.runs ?? []) if (['running', 'waiting', 'queued'].includes(run.status) && run.sessionRef && !(snapshot.tombstones ?? []).some(item => item.sessionId === run.sessionRef)) activeSessions.add(run.sessionRef)
    for (const goal of snapshot.goals) publish(AGENT_IPC_CHANNELS.GOAL_EVENT, { sessionId: goal.sessionId, state: goal })
    for (const pending of snapshot.pending) {
      const requests = [...pending.permissions.map(request => ({ type: 'permission_request', request })), ...pending.askUsers.map(request => ({ type: 'ask_user_request', request })), ...pending.exitPlans.map(request => ({ type: 'exit_plan_mode_request', request }))]
      for (const event of requests) publish(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId: pending.sessionId, payload: { kind: 'profer_event', event } })
    }
    publish(AUTOMATION_IPC_CHANNELS.CHANGED)
    invalidateWorkspaceLocation()
    publish(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
  })
  unsubscribeAutomation = next.addAutomationEventListener(() => publish(AUTOMATION_IPC_CHANNELS.CHANGED))
  unsubscribeWorkspace = next.addWorkspaceEventListener(() => {
    if (client !== next) return
    invalidateWorkspaceLocation()
    publish(AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)
  })
}

export function detachLocalCoreClient(closeClient = true): void {
  unsubscribe?.()
  unsubscribeSnapshot?.()
  unsubscribeAutomation?.()
  unsubscribeWorkspace?.()
  unsubscribeWorkspace = undefined
  unsubscribeSnapshot = undefined
  unsubscribeAutomation = undefined
  unsubscribe = undefined
  if (closeClient) client?.close()
  client = null
  handlers.clear()
  activeSessions.clear()
}

export function getLocalCoreClient(): CoreClient | null {
  return client
}

/** 显式启用 Core 时不能因启动失败静默退回旧 Pi 链路。 */
export function shouldUseLocalCorePi(runtime: string | undefined, enabled = process.env.PROFER_CORE_LOCAL === '1'): boolean {
  if ((runtime !== 'pi' && runtime !== 'claude') || (!enabled && !client)) return false
  if (!client) throw new Error('本地 Core 尚未就绪或启动失败，请检查启动日志后重试')
  return true
}

export function isLocalCoreSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export function registerLocalCoreSession(sessionId: string, handler: LocalCoreSessionEventHandler): () => void {
  handlers.set(sessionId, handler)
  activeSessions.add(sessionId)
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId)
    activeSessions.delete(sessionId)
  }
}

/** 复用桌面入口的绑定校验与请求级凭据解析，旧会话的过期渠道不能覆盖本次选择。 */
export async function prepareLocalCoreMessage(input: AgentSendInput, deps: {
  getSession(sessionId: string): AgentSessionMeta | undefined
  getChannel(channelId: string): Channel | undefined
  credentials: CredentialPort
}): Promise<CoreMessageOptions> {
  const session = deps.getSession(input.sessionId)
  const binding = validateAgentSendBinding(input, session, true, deps.getChannel(input.channelId))
  if (!binding.ok) throw new Error(`${binding.code}: ${binding.message}`)
  const result = await deps.credentials.resolve({ sessionId: input.sessionId, runtime: input.agentRuntime ?? session?.agentRuntime ?? 'pi', channelId: input.channelId, modelId: input.modelId })
  if (!result.ok) {
    const detail = resolveCredentialPreflightTypedError(result.code)
    throw new Error(`${result.code}: ${detail?.message ?? '无法解析当前渠道凭据'}`)
  }
  const uuid = input.uuid ?? randomUUID()
  return {
    channelId: input.channelId,
    modelId: input.modelId,
    uuid,
    rawUserMessage: input.rawUserMessage ?? input.userMessage,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    context: createAgentRunContext({ ...input, uuid }, randomUUID),
    credentials: result.credentials,
  }
}

export async function sendLocalCoreMessage(sessionId: string, prompt: string, options?: CoreMessageOptions): Promise<void> {
  if (!client) throw new Error('本地 Core 尚未启动')
  try {
    await client.sendMessage(sessionId, prompt, options)
  } catch (error) {
    activeSessions.delete(sessionId)
    throw error
  }
}

export async function stopLocalCoreSession(sessionId: string): Promise<void> {
  if (!client) return
  await client.stop(sessionId)
}
