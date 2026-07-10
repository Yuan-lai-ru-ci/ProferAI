/**
 * Agent 协作会话纯工具函数
 *
 * 不依赖 Electron 和磁盘服务，便于单元测试。
 */

import type { AgentSessionMeta, PromaPermissionMode } from '@profer/shared'

export type AgentDelegationRole = 'explore' | 'research' | 'implement' | 'review' | 'custom'

export type AgentDelegationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

const PERMISSION_RANK: Record<PromaPermissionMode, number> = {
  plan: 0,
  auto: 1,
  bypassPermissions: 2,
}

/** 最大运行中子会话数 */
export const MAX_RUNNING_DELEGATIONS_PER_PARENT = 50

/** 委派恢复快照 */
export interface RecoveredDelegationState {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  title: string
  role: AgentDelegationRole
  goal: string
  permissionMode: PromaPermissionMode
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
}

/**
 * 解析委派子会话的实际权限模式：
 * 取父模式和请求模式中更严格者。
 */
export function resolveDelegationPermissionMode(
  parentMode: PromaPermissionMode | undefined,
  requestedMode: PromaPermissionMode | undefined,
): PromaPermissionMode {
  const parent = parentMode ?? 'auto'
  const requested = requestedMode ?? parent
  return PERMISSION_RANK[requested] <= PERMISSION_RANK[parent] ? requested : parent
}

/**
 * 从持久化的 AgentSessionMeta 恢复委派状态快照。
 */
export function buildRecoveredDelegationState(input: {
  parentSessionId: string
  delegationId: string
  session: AgentSessionMeta
  fallbackPermissionMode?: PromaPermissionMode
}): RecoveredDelegationState {
  const persistedStatus = input.session.delegationStatus
  const status: AgentDelegationStatus = persistedStatus === 'running'
    ? 'interrupted'
    : (persistedStatus as AgentDelegationStatus | undefined) ?? 'interrupted'
  return {
    delegationId: input.delegationId,
    parentSessionId: input.parentSessionId,
    childSessionId: input.session.id,
    title: input.session.title,
    role: (input.session.delegationRole as AgentDelegationRole) ?? 'custom',
    goal: input.session.delegationGoal ?? '',
    permissionMode: input.session.permissionMode ?? input.fallbackPermissionMode ?? 'auto',
    status,
    startedAt: input.session.createdAt,
    completedAt: persistedStatus ? input.session.updatedAt : undefined,
  }
}

/**
 * 构建发送给子 Agent 的委派提示词。
 */
export function buildDelegationPrompt(input: {
  parentSessionId: string
  delegationId: string
  role: AgentDelegationRole
  task: string
  expectedOutput?: string
}): string {
  const expectedOutput = input.expectedOutput?.trim()
  return `你是 Proma 协作子 Agent。你由父 Agent 会话 ${input.parentSessionId} 委派创建，委派 ID 为 ${input.delegationId}。

## 工作边界

- 只处理下面的子任务，不要扩展到父任务的其他部分。
- 不要创建新的协作子会话。
- 如需修改文件，保持改动最小，并在最终回复说明文件路径和验证结果。
- 如果信息不足，直接列出缺口，不要编造。

## 子任务角色

${input.role}

## 子任务

${input.task.trim()}

## 输出要求

${expectedOutput || '最终回复请包含：关键发现、已执行操作、验证结果、剩余风险或建议。'}`
}

/**
 * 将共享上下文拼入子任务描述。
 */
export function buildDelegationTaskWithSharedContext(input: {
  sharedContext?: string
  task: string
}): string {
  const sharedContext = input.sharedContext?.trim()
  const task = input.task.trim()
  if (!sharedContext) return task

  return `共享背景：
${sharedContext}

子任务：
${task}`
}
