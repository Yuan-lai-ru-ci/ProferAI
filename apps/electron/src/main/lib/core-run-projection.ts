import type { CoreAgentEvent } from './core-client'

export interface RemoteRunCompletion {
  sessionId: string
  messages: []
  runId?: string
  taskId?: string
  triggerId?: string
  outcomeStatus?: 'completed' | 'failed' | 'stopped'
  stopReason?: string
  stoppedByUser: boolean
  resultSubtype?: string
  resultErrors?: string[]
  /** 与 runtime_started 同一轮的开始时间；桌面用它区分新旧流。 */
  startedAt?: number
}

export interface RemoteRunProjection {
  eventPayload?: Record<string, unknown>
  completion?: RemoteRunCompletion
  error?: string
}

export function projectRemoteRunEvent(event: CoreAgentEvent, localSessionId: string): RemoteRunProjection | null {
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload) return null
  if (payload.kind === 'session_deletion') return { eventPayload: { ...payload, sessionId: localSessionId } }
  if (payload.kind === 'session_projection' && payload.operation === 'delete') {
    return { eventPayload: { ...payload, sessionId: localSessionId } }
  }
  if (payload.kind === 'session_projection' && payload.session && typeof payload.session === 'object') {
    const session = { ...payload.session } as Record<string, unknown>
    const prefix = /^core:[^:]+:/.exec(localSessionId)?.[0]
    session.id = localSessionId
    if (prefix) for (const key of ['parentSessionId', 'rootSessionId', 'sourceSessionId', 'explorationParentSessionId']) {
      if (typeof session[key] === 'string' && session[key]) session[key] = `${prefix}${session[key]}`
    }
    return { eventPayload: { ...payload, session } }
  }
  if (payload.kind === 'sdk_message' && payload.message) return { eventPayload: { kind: 'sdk_message', message: payload.message } }
  if (payload.kind === 'profer_event' && payload.event && typeof payload.event === 'object') {
    const remoteEvent = { ...payload.event } as Record<string, unknown>
    const corePrefix = /^core:[^:]+:/.exec(localSessionId)?.[0]
    const projectId = (id: unknown) => corePrefix && typeof id === 'string' && id ? `${corePrefix}${id}` : id
    if (remoteEvent.type === 'delegation_session_updated' && remoteEvent.session && typeof remoteEvent.session === 'object') {
      const session = { ...remoteEvent.session } as Record<string, unknown>
      for (const key of ['id', 'parentSessionId', 'sourceSessionId', 'rootSessionId']) session[key] = projectId(session[key])
      remoteEvent.session = session
    }
    if (remoteEvent.type === 'delegation_blocked' && remoteEvent.blockedEvent && typeof remoteEvent.blockedEvent === 'object') {
      const blocked = remoteEvent.blockedEvent as Record<string, unknown>
      remoteEvent.blockedEvent = { ...blocked, childSessionId: projectId(blocked.childSessionId) }
    }
    if (remoteEvent.sessionId) remoteEvent.sessionId = localSessionId
    if (['permission_request', 'ask_user_request', 'exit_plan_mode_request'].includes(String(remoteEvent.type)) && remoteEvent.request && typeof remoteEvent.request === 'object') {
      const request = remoteEvent.request as Record<string, unknown>
      return { eventPayload: { kind: 'profer_event', event: { ...remoteEvent, request: { ...request, sessionId: localSessionId } } } }
    }
    if (remoteEvent.type === 'permission_resolved') return { eventPayload: { kind: 'profer_event', event: remoteEvent } }
    const completion = remoteEvent.type === 'run_completed'
      ? {
          sessionId: localSessionId,
          messages: [] as [],
          ...(typeof remoteEvent.runId === 'string' ? { runId: remoteEvent.runId } : {}),
          ...(typeof remoteEvent.taskId === 'string' ? { taskId: remoteEvent.taskId } : {}),
          ...(typeof remoteEvent.triggerId === 'string' ? { triggerId: remoteEvent.triggerId } : {}),
          ...(typeof remoteEvent.stopReason === 'string' ? { stopReason: remoteEvent.stopReason } : {}),
          ...(['completed', 'failed', 'stopped'].includes(String(remoteEvent.outcomeStatus)) ? { outcomeStatus: remoteEvent.outcomeStatus as 'completed' | 'failed' | 'stopped' } : {}),
          stoppedByUser: remoteEvent.stoppedByUser === true,
          ...(typeof remoteEvent.startedAt === 'number' ? { startedAt: remoteEvent.startedAt } : {}),
          ...(typeof remoteEvent.resultSubtype === 'string' ? { resultSubtype: remoteEvent.resultSubtype } : {}),
          ...(Array.isArray(remoteEvent.resultErrors) ? { resultErrors: remoteEvent.resultErrors.filter((item): item is string => typeof item === 'string') } : {}),
        }
      : undefined
    return { eventPayload: { kind: 'profer_event', event: remoteEvent }, ...(completion ? { completion } : {}) }
  }
  if (payload.kind === 'run_error') return { error: String(payload.error ?? '远程 Core 执行失败') }
  return { eventPayload: payload }
}
