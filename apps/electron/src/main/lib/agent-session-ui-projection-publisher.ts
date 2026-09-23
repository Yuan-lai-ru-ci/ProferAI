import type { AgentSessionMeta, AgentStreamPayload } from '@profer/shared'
import type { AgentEventBus } from './agent-event-bus'
import { updateAgentSessionMeta } from './agent-session-manager'
import { buildAgentSessionUiProjection } from './agent-session-ui-projection'

let projectionEventBus: AgentEventBus | null = null

/** Configure the single EventBus used by all UI projection mutations. */
export function configureAgentSessionProjectionPublisher(eventBus: AgentEventBus): void {
  projectionEventBus = eventBus
}

function emitProjection(sessionId: string, payload: AgentStreamPayload): void {
  if (!projectionEventBus) throw new Error('Agent session projection publisher 尚未初始化')
  projectionEventBus.emit(sessionId, payload)
}

/** Publish the canonical safe snapshot after a successful session metadata mutation. */
export function publishAgentSessionProjection(meta: AgentSessionMeta): void {
  emitProjection(meta.id, {
    kind: 'session_projection',
    operation: 'upsert',
    session: buildAgentSessionUiProjection(meta),
  })
}

/** Mutate session UI metadata and publish it through the unified projection plane. */
export function updateAgentSessionUiMeta(
  id: string,
  updates: Parameters<typeof updateAgentSessionMeta>[1],
): AgentSessionMeta {
  const updated = updateAgentSessionMeta(id, updates)
  publishAgentSessionProjection(updated)
  return updated
}

/** Publish a revision tombstone so delayed upserts cannot resurrect a deleted session. */
export function publishAgentSessionDeletion(sessionId: string, revision: number): void {
  emitProjection(sessionId, {
    kind: 'session_projection',
    operation: 'delete',
    sessionId,
    revision,
  })
}
