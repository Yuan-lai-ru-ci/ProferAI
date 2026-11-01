import type { ActorRef, TaskAuthorization, TaskOrigin } from '@profer/agent-fabric'
import type { AgentRuntime, AgentSessionMeta, AgentSendInput, Automation, AutomationTriggerRecord, Channel } from '@profer/shared'
import { isChannelEnabledForRuntime } from '@profer/shared'

export interface AutomationDispatchMetadata {
  taskId: string
  triggerId: string
  taskOrigin: TaskOrigin
  taskAuthorization: TaskAuthorization
  messageAuthor: ActorRef
}

export function createAutomationOccurrenceId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${Math.trunc(scheduledAt)}`
}

export function createAutomationTriggerId(automationId: string, scheduledAt: number): string {
  return createAutomationOccurrenceId(automationId, scheduledAt)
}

export function buildAutomationDispatchMetadata(input: {
  automation: Pick<Automation, 'id' | 'promptAuthor'>
  triggerId: string
}): AutomationDispatchMetadata {
  const { automation } = input
  return {
    taskId: `automation:${automation.id}`,
    triggerId: input.triggerId,
    taskOrigin: {
      actor: { type: 'automation', id: automation.id },
      source: { type: 'automation', id: automation.id },
    },
    taskAuthorization: {
      kind: 'scheduled',
      sourceRef: { type: 'automation', id: automation.id },
    },
    messageAuthor: automation.promptAuthor ?? { type: 'automation', id: automation.id },
  }
}

export function applyAutomationDispatchMetadata(
  input: AgentSendInput,
  metadata: AutomationDispatchMetadata,
): AgentSendInput {
  return {
    ...input,
    taskId: metadata.taskId,
    triggerId: metadata.triggerId,
    taskOrigin: metadata.taskOrigin,
    taskAuthorization: metadata.taskAuthorization,
    messageAuthor: metadata.messageAuthor,
  }
}

export function withTrustedAutomationPromptAuthor<T extends { prompt?: string; promptAuthor?: ActorRef }>(
  input: T,
  trustedAuthor: ActorRef,
): Omit<T, 'promptAuthor'> & { promptAuthor?: ActorRef } {
  const { promptAuthor: _untrustedPromptAuthor, ...fields } = input
  return input.prompt === undefined ? fields : { ...fields, promptAuthor: trustedAuthor }
}

export function validateBoundAutomationSession(
  automation: Pick<Automation, 'workspaceId' | 'channelId' | 'agentRuntime' | 'presetId'>,
  session: Pick<AgentSessionMeta, 'workspaceId' | 'channelId' | 'agentRuntime' | 'presetId'> | undefined,
  expectedPresetId?: string,
): { valid: true } | { valid: false; reason: string } {
  if (!session) return { valid: false, reason: '绑定会话不存在或不可访问' }
  if (session.workspaceId !== automation.workspaceId) return { valid: false, reason: '绑定会话工作区不匹配' }
  if (session.channelId !== automation.channelId) return { valid: false, reason: '绑定会话渠道不匹配' }
  if ((session.agentRuntime ?? 'claude') !== (automation.agentRuntime ?? 'claude')) {
    return { valid: false, reason: '绑定会话 Agent runtime 不匹配' }
  }
  const effectiveSessionPresetId = session.presetId ?? (automation.presetId ? undefined : expectedPresetId)
  if (expectedPresetId && effectiveSessionPresetId !== expectedPresetId) return { valid: false, reason: '绑定会话预设不匹配' }
  return { valid: true }
}

export function validateBoundAutomationChannel(
  automation: Pick<Automation, 'channelId' | 'modelId' | 'agentRuntime'>,
  session: Pick<AgentSessionMeta, 'modelId'>,
  channel: Pick<Channel, 'enabled' | 'provider' | 'agentExperimentalEnabled' | 'agentRuntimes' | 'models'> | undefined,
): { valid: true } | { valid: false; reason: string } {
  const runtime = automation.agentRuntime ?? 'claude'
  if (!channel || !isChannelEnabledForRuntime(channel, runtime)) {
    return { valid: false, reason: '目标会话渠道未启用或不支持当前 Agent runtime' }
  }
  if (!session.modelId || !channel.models.some((model) => model.id === session.modelId && model.enabled)) {
    return { valid: false, reason: '目标会话模型不可用' }
  }
  if (automation.modelId && (!channel.models.some((model) => model.id === automation.modelId && model.enabled)
    || automation.modelId !== session.modelId)) {
    return { valid: false, reason: '定时任务模型与目标会话模型不匹配' }
  }
  return { valid: true }
}

export function enqueueAutomationTrigger(
  records: readonly AutomationTriggerRecord[],
  record: AutomationTriggerRecord,
  now: number,
): AutomationTriggerRecord[] {
  if (records.some((item) => item.triggerId === record.triggerId)) return records.map((item) => ({ ...item }))
  return [...records.map((item) => ({ ...item })), { ...record, createdAt: now, updatedAt: now }]
}

export function transitionAutomationTrigger(
  record: AutomationTriggerRecord,
  status: AutomationTriggerRecord['status'],
  now: number,
  patch: Partial<Pick<AutomationTriggerRecord, 'boundSessionId' | 'targetSessionId' | 'runId' | 'error'>> = {},
): AutomationTriggerRecord {
  const allowed = record.status === 'queued' && (status === 'queued' || status === 'running' || status === 'blocked' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted')
    || record.status === 'blocked' && (status === 'blocked' || status === 'queued' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted')
    || record.status === 'running' && (status === 'completed' || status === 'failed' || status === 'blocked' || status === 'interrupted')
  if (!allowed) throw new Error(`非法 automation trigger 状态迁移: ${record.status} -> ${status}`)
  return { ...record, ...patch, status, updatedAt: now }
}

/** 启动时保留未派发/阻塞记录；已启动的旧进程记录不自动重放。 */
export function normalizeAutomationTriggerRecords(records: readonly AutomationTriggerRecord[], now: number): AutomationTriggerRecord[] {
  // queued/blocked 等待对账；running 是旧进程已启动事实，重启后只收敛 interrupted。
  return records.map((record) => record.status === 'running'
    ? { ...record, status: 'interrupted', error: '应用重启时运行状态无法恢复', updatedAt: now }
    : { ...record })
}

export function isSettledAutomationTrigger(record: Pick<AutomationTriggerRecord, 'status'>): boolean {
  return record.status === 'completed' || record.status === 'failed' || record.status === 'interrupted'
}

export function isRecoverableAutomationTrigger(record: Pick<AutomationTriggerRecord, 'status'>): boolean {
  return record.status === 'queued' || record.status === 'blocked'
}

export function runtimeForAutomation(automation: Pick<Automation, 'agentRuntime'>): AgentRuntime {
  return automation.agentRuntime ?? 'claude'
}
