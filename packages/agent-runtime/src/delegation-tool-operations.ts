import type { AgentRuntime, AgentSessionMeta, DelegationBlockedEvent, PresetReference, ProferPermissionMode } from '@profer/shared'
import type { AgentDelegationRole, AgentDelegationStatus, DelegationPlacement, DelegationRelation } from './delegation-tools'

export interface DelegationContext {
  sessionId: string
  sourceRunId?: string
  channelId: string
  modelId?: string
  workspaceId?: string
  agentRuntime?: AgentRuntime
  permissionMode?: ProferPermissionMode
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'goal'
  signal?: AbortSignal
  /** 宿主命令或真实工具调用身份；只用于业务防重，不是授权证明。 */
  operationId?: string
}
export interface DelegateInput {
  operationId?: string
  title?: string
  role?: AgentDelegationRole
  task: string
  expectedOutput?: string
  modelId?: string
  presetReference?: PresetReference
  placement?: DelegationPlacement
  relation?: DelegationRelation
}
export interface DelegateBatchInput { operationId?: string; sharedContext?: string; items: DelegateInput[] }
export interface DelegationWaitInput {
  delegationIds?: string[]
  mode?: 'all' | 'any'
  minCompleted?: number
  timeoutSeconds?: number
}
export interface DelegationAnswerInput {
  blockedEventId: string
  answers?: Record<string, string>
  permissionBehavior?: 'allow' | 'deny'
}
export interface DelegationToolOperations {
  listAvailableModels(ctx: DelegationContext): Record<string, unknown>
  delegate(ctx: DelegationContext, input: DelegateInput): Promise<Record<string, unknown>>
  delegateBatch(ctx: DelegationContext, input: DelegateBatchInput): Promise<Record<string, unknown>>
  wait(ctx: DelegationContext, input: DelegationWaitInput): Promise<Record<string, unknown>>
  list(ctx: DelegationContext, input: { includeCompleted?: boolean }): Record<string, unknown>
  getResults(ctx: DelegationContext, ids: string[]): Record<string, unknown>
  stop(ctx: DelegationContext, id: string): Promise<Record<string, unknown>>
  stopMany(ctx: DelegationContext, ids?: string[]): Promise<Record<string, unknown>>
  answer(ctx: DelegationContext, input: DelegationAnswerInput): Promise<Record<string, unknown>>
  continue(ctx: DelegationContext, input: { operationId?: string; delegationId: string; message: string }): Promise<Record<string, unknown>>
}
export interface DelegationRecordView {
  delegationId: string
  taskId: string
  sourceSessionId: string
  parentSessionId: string
  sourceRunId?: string
  childSessionId: string
  placement: DelegationPlacement
  relation: DelegationRelation
  projection?: { sessionId: string; executionSessionId: string; taskId: string }
  channelId: string
  modelId?: string
  title: string
  role: AgentDelegationRole
  goal: string
  permissionMode: ProferPermissionMode
  presetReference?: PresetReference
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
  error?: string
  resultSummary?: string
  resultConsumedAt?: number
  pendingBlockedEvents: readonly DelegationBlockedEvent[]
}
export type CollaborationToolContext = DelegationContext
export type DelegateAgentArgs = DelegateInput
export function buildDelegationContext(session: AgentSessionMeta, sourceRunId?: string, signal?: AbortSignal): DelegationContext {
  return { sessionId: session.id, sourceRunId, channelId: session.channelId ?? '', modelId: session.modelId,
    workspaceId: session.workspaceId, agentRuntime: session.agentRuntime, permissionMode: session.permissionMode, signal }
}
export const DEFAULT_WAIT_SECONDS = 1800
export const MAX_WAIT_SECONDS = 7200
