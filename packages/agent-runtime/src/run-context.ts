import type { ActorRef, MessageProvenance } from '@profer/agent-fabric'
import type { AgentRunInitiator, AgentSendInput, SDKMessage } from '@profer/shared'
import type { AgentRun, TaskTrigger } from './run-ledger'

export interface AgentRunContext {
  trigger: TaskTrigger
  taskId?: string
  messageAuthor?: ActorRef
}

/** 预设变更意图只从真实用户输入解析；外部/框架正文不能触发用户确认分支。 */
export function resolveAgentInputOperationSource(input: Pick<AgentSendInput, 'taskOrigin' | 'triggeredBy' | 'initiator'>): 'user' | 'automation' | 'delegation' | 'goal' {
  const actor = input.taskOrigin?.actor.type
  if (actor === 'automation' || input.triggeredBy === 'automation') return 'automation'
  if (input.triggeredBy === 'goal') return 'goal'
  if (actor && actor !== 'user') return 'delegation'
  if (actor === 'user') return 'user'
  return input.triggeredBy ?? (input.initiator === 'external' || input.initiator === 'delegation' ? 'delegation' : input.initiator ?? 'user')
}

/** 只接受宿主已核实的输入；本函数不从正文或 Provider role 解析身份和授权。 */
export function createAgentRunContext(
  input: Pick<AgentSendInput, 'sessionId' | 'uuid' | 'taskOrigin' | 'taskAuthorization' | 'taskId' | 'triggerId' | 'messageAuthor' | 'triggeredBy' | 'initiator'>,
  createId: () => string,
  now: () => number = Date.now,
): AgentRunContext {
  const initiator: AgentRunInitiator = input.initiator ?? input.triggeredBy ?? 'user'
  const actor = input.taskOrigin?.actor ?? (initiator === 'user' ? { type: 'user' as const }
    : initiator === 'automation' ? { type: 'automation' as const }
      : initiator === 'delegation' ? { type: 'agent' as const }
        : initiator === 'external' ? { type: 'external' as const } : { type: 'system' as const })
  const kind: TaskTrigger['kind'] = actor.type === 'user' ? 'user_message'
    : actor.type === 'agent' ? 'delegation' : actor.type === 'automation' ? 'automation' : 'external_request'
  return {
    trigger: {
      schemaVersion: 1,
      id: input.triggerId ?? (input.uuid ? `message:${input.sessionId}:${input.uuid}` : createId()),
      kind,
      actor,
      ...(input.taskOrigin?.source ? { source: input.taskOrigin.source } : {}),
      ...(input.taskAuthorization ? { authorization: input.taskAuthorization }
        : actor.type === 'user' ? { authorization: { kind: 'direct' as const, ...(input.uuid ? { sourceRef: { type: 'message' as const, id: input.uuid } } : {}) } } : {}),
      createdAt: now(),
    },
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.messageAuthor ? { messageAuthor: input.messageAuthor } : {}),
  }
}

export function stampRunMessage(
  message: SDKMessage,
  run: Pick<AgentRun, 'id' | 'sessionRef' | 'taskId' | 'triggerId' | 'executorRef'>,
  author: ActorRef,
  createId: () => string,
  trigger?: TaskTrigger,
): SDKMessage {
  const messageRecord = message as SDKMessage & { uuid?: unknown }
  const messageId = typeof messageRecord.uuid === 'string' ? messageRecord.uuid : createId()
  const provenance: MessageProvenance = {
    schemaVersion: 1,
    messageId,
    author,
    runId: run.id,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    triggerId: trigger?.id ?? run.triggerId,
    ...(trigger?.source ? { source: trigger.source } : {}),
  }
  return { ...message, _provenance: provenance }
}
