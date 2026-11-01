/**
 * Task 与 Task Policy 契约
 *
 * Task 是系统统一派工单位：调用方是 Hermes、Profer 当前会话还是另一个本地 Agent，
 * 不改变任务内部结构。
 *
 * 上下文显式传递原则：子任务不会因为拥有 parentTaskId 就自动获得父会话的
 * 消息、文件权限、凭据或审批权限；敏感内容只走受控引用（artifactIds），
 * 禁止把 key / token / 环境变量直接塞进 payload。
 */

import type { CapabilityValue } from './capabilities'
import type { TaskAuthorization, TaskOrigin } from './origin'
import { ProtocolError, ProtocolErrorCode } from './protocol'

// ===== 状态（迁移规则见 state-machine.ts） =====

export const TaskStatus = {
  CREATED: 'created',
  QUEUED: 'queued',
  ROUTING: 'routing',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  DELEGATING: 'delegating',
  WAITING_FOR_CHILDREN: 'waiting_for_children',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  WAITING_FOR_INPUT: 'waiting_for_input',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const

export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus]

// ===== 审批与工作区模式 =====

/**
 * 审批模式：
 * - forward_to_user：高风险操作审批归原始用户，经 Gateway 转发一次性决定；
 * - auto_deny：无用户在场时默认拒绝（headless / 未配对调用方的安全默认）。
 * 不存在 auto_approve：审批不能因为调用方是 Agent 就跳过用户。
 */
export const ApprovalMode = {
  FORWARD_TO_USER: 'forward_to_user',
  AUTO_DENY: 'auto_deny',
} as const

export type ApprovalModeValue = (typeof ApprovalMode)[keyof typeof ApprovalMode]

/**
 * 工作区并发模式（限制强度递增：read-shared < isolated-writer < single-writer）：
 * - read-shared：可并发读，禁止写；
 * - isolated-writer：每个写任务独立 worktree/临时目录；
 * - single-writer：同一目录同一时间只有一个写任务（writer lease）。
 */
export const WorkspaceMode = {
  READ_SHARED: 'read-shared',
  ISOLATED_WRITER: 'isolated-writer',
  SINGLE_WRITER: 'single-writer',
} as const

export type WorkspaceModeValue = (typeof WorkspaceMode)[keyof typeof WorkspaceMode]

/** 模式限制强度排名，子任务只允许沿排名不变或更受限方向移动。 */
export const WORKSPACE_MODE_RESTRICTIVENESS: Record<WorkspaceModeValue, number> = {
  [WorkspaceMode.READ_SHARED]: 0,
  [WorkspaceMode.ISOLATED_WRITER]: 1,
  [WorkspaceMode.SINGLE_WRITER]: 2,
}

/** 崩溃/断线后的重试分类：涉及文件修改的任务不能默认自动重试。 */
export const RetryClass = {
  SAFE_TO_RETRY: 'safe-to-retry',
  RETRY_WITH_CLEAN_WORKTREE: 'retry-with-clean-worktree',
  MANUAL_REVIEW_REQUIRED: 'manual-review-required',
  NOT_RETRYABLE: 'not-retryable',
} as const

export type RetryClassValue = (typeof RetryClass)[keyof typeof RetryClass]

// ===== 任务 Policy =====

export interface WriteIntent {
  /** 预期写入路径（workspace 相对路径）。 */
  paths: readonly string[]
  /** 冲突策略：fail = 有写冲突即拒绝；queue = 等待 writer lease。 */
  conflictStrategy: 'fail' | 'queue'
}

/**
 * 任务策略边界。核心不变量：子任务策略只能继承或收窄，不能扩大。
 * 收窄规则由 task-graph.ts 的 narrowPolicy 强制执行。
 */
export interface TaskPolicy {
  approvalMode: ApprovalModeValue
  allowDelegation: boolean
  maxDelegationDepth: number
  maxChildren: number
  timeoutSeconds: number
  workspaceMode: WorkspaceModeValue
  /** 声明写意图；workspaceMode 为 read-shared 时必须为空。 */
  writeIntent?: WriteIntent
  /** 在调用方 grant 基础上进一步收窄的能力白名单。 */
  allowedCapabilities?: readonly CapabilityValue[]
  retryClass: RetryClassValue
  /** 预算上限（如模型 token / 费用，单位由实现约定）。 */
  budget?: { maxUnits: number; unit: string }
}

// ===== 任务请求与任务实体 =====

/** 显式上下文：文件引用与产物引用，不包含父会话消息或凭据。 */
export interface TaskContext {
  files?: readonly string[]
  artifactIds?: readonly string[]
  /** 额外结构化提示；仍会经过敏感内容检查。 */
  notes?: string
}

export interface TaskRequest {
  /** 旧请求允许缺省；新来源契约使用版本 1。 */
  schemaVersion?: 1
  origin?: TaskOrigin
  authorization?: TaskAuthorization
  taskId: string
  parentTaskId?: string
  rootTaskId: string
  requesterAgentId: string
  orchestratorAgentId: string
  /**
   * 目标节点逻辑身份。解析只允许走 Agent Registry，
   * payload 自带任意 URL 绕过注册/认证/授权是协议违规。
   */
  targetAgentId: string
  objective: string
  workspaceId: string
  preset?: string
  constraints: readonly string[]
  context?: TaskContext
  dependsOn: readonly string[]
  policy: TaskPolicy
  submittedAt: number
}

export interface TaskLease {
  leaseId: string
  acquiredByInstanceId: string
  expiresAt: number
  heartbeatAt: number
}

/** 任务实体 = 请求 + 生命周期状态 + 租约。 */
export interface AgentTask {
  request: TaskRequest
  /** 关联的逻辑执行轮次；Task 不拥有整个 Session 的运行历史。 */
  runIds?: readonly string[]
  status: TaskStatusValue
  createdAt: number
  updatedAt: number
  /** waiting_for_approval / waiting_for_input 必须保留恢复所需上下文。 */
  pendingApprovalId?: string
  pendingInputRequestId?: string
  lease?: TaskLease
  failureReason?: string
}

// ===== 工作目标的只读投影 =====

export type TaskState = 'open' | 'completed' | 'cancelled'

/** 不改变旧协议状态：失败/过期表示一次执行结束，工作目标仍开放。 */
export function deriveTaskState(task: Pick<AgentTask, 'status'>): TaskState {
  if (task.status === TaskStatus.COMPLETED) return 'completed'
  if (task.status === TaskStatus.CANCELLED) return 'cancelled'
  return 'open'
}

/** 从唯一可写 AgentTask 派生；不提供第二个 Task 存储或修改入口。 */
export interface TaskView {
  readonly id: string
  readonly objective: string
  readonly origin: { readonly actor: Readonly<TaskOrigin['actor']>; readonly source?: Readonly<NonNullable<TaskOrigin['source']>> }
  readonly authorization?: { readonly kind: TaskAuthorization['kind']; readonly sourceRef?: Readonly<NonNullable<TaskAuthorization['sourceRef']>> }
  readonly parentTaskId?: string
  readonly workspaceRef: string
  readonly state: TaskState
  readonly createdAt: number
  readonly updatedAt: number
  readonly runIds?: readonly string[]
}

export function createTaskView(task: AgentTask): TaskView {
  const { request } = task
  return {
    id: request.taskId,
    objective: request.objective,
    origin: request.origin
      ? { actor: { ...request.origin.actor }, ...(request.origin.source ? { source: { ...request.origin.source } } : {}) }
      : { actor: { type: 'unknown' } },
    ...(request.authorization ? { authorization: {
      kind: request.authorization.kind,
      ...(request.authorization.sourceRef ? { sourceRef: { ...request.authorization.sourceRef } } : {}),
    } } : {}),
    ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
    workspaceRef: request.workspaceId,
    state: deriveTaskState(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.runIds ? { runIds: [...task.runIds] } : {}),
  }
}

// ===== 校验 =====

/**
 * 禁止内联出现在任务上下文中的敏感键。
 * 命中任一模式即拒收整份 payload：敏感内容只走受控引用。
 */
const FORBIDDEN_INLINE_KEY_PATTERNS: readonly RegExp[] = [
  /api[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /private[-_]?key/i,
  /\benv\b/i,
]

function scanForForbiddenKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForForbiddenKeys(item, `${path}[${index}]`, hits))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key
      if (FORBIDDEN_INLINE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        hits.push(childPath)
        continue
      }
      scanForForbiddenKeys(child, childPath, hits)
    }
  }
}

/** 校验任务请求结构与边界；不合法抛 ProtocolError。 */
export function validateTaskRequest(request: TaskRequest): void {
  if (request.schemaVersion !== undefined && request.schemaVersion !== 1) {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, `不支持的任务来源版本：${request.schemaVersion}`)
  }
  if (!request.taskId || request.taskId.trim() === '') {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, 'taskId 不能为空')
  }
  if (!request.objective || request.objective.trim() === '') {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, '任务 objective 不能为空')
  }
  if (!request.workspaceId || request.workspaceId.trim() === '') {
    throw new ProtocolError(ProtocolErrorCode.VALIDATION_FAILED, 'workspaceId 不能为空：任务必须绑定明确工作区')
  }
  if (!request.targetAgentId || !request.requesterAgentId || !request.orchestratorAgentId) {
    throw new ProtocolError(
      ProtocolErrorCode.VALIDATION_FAILED,
      'requesterAgentId / orchestratorAgentId / targetAgentId 均为必填（审计与路由依赖）',
    )
  }

  const { policy } = request
  if (policy.maxDelegationDepth < 0 || policy.maxChildren < 0 || policy.timeoutSeconds <= 0) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_VIOLATION,
      'policy 边界非法：maxDelegationDepth/maxChildren 不能为负，timeoutSeconds 必须为正',
    )
  }
  if (!policy.allowDelegation && (policy.maxDelegationDepth > 0 || policy.maxChildren > 0)) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_VIOLATION,
      'policy 自相矛盾：allowDelegation=false 时 maxDelegationDepth/maxChildren 必须为 0',
    )
  }
  if (policy.workspaceMode === WorkspaceMode.READ_SHARED && policy.writeIntent && policy.writeIntent.paths.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_VIOLATION,
      'read-shared 模式禁止声明写意图',
    )
  }
  if (policy.workspaceMode !== WorkspaceMode.READ_SHARED && (policy.writeIntent?.paths.length ?? 0) === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.POLICY_VIOLATION,
      '写模式任务必须声明 writeIntent.paths（预期路径与冲突策略）',
    )
  }

  const sensitiveHits: string[] = []
  scanForForbiddenKeys(request.context, 'context', sensitiveHits)
  if (sensitiveHits.length > 0) {
    throw new ProtocolError(
      ProtocolErrorCode.SENSITIVE_INLINE_CONTENT,
      `任务上下文包含疑似敏感字段：${sensitiveHits.join('、')}。敏感内容只通过受控引用传递`,
      { details: { hits: sensitiveHits } },
    )
  }
}
