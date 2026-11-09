/**
 * 对话回退产品契约。
 *
 * 该文件只描述跨 renderer/main/provider 的数据边界，不执行任何回退动作。
 * 旧版 RewindSessionInput/Result 保留在 agent.ts，迁移接线由 D4/D6 完成。
 */

import type { AgentRuntime } from './agent-provider'

/** 回退范围必须显式选择；省略 mode 不代表文件回退。 */
export type RewindMode = 'conversation' | 'files' | 'both'

/** 逻辑轮次边界。after-turn T1 与 before-turn T2 可指向同一状态，但语义不同。 */
export type RewindTarget =
  | { kind: 'after-turn'; turnId: string }
  | { kind: 'before-turn'; turnId: string }
  | { kind: 'message'; messageUuid: string }
  | { kind: 'session-start' }

export type RewindFileAction = 'restore' | 'delete' | 'keep' | 'conflict'

export interface RewindFilePlanItem {
  itemId: string
  path: string
  /** Authorized workspace root and normalized path within that root. */
  rootId?: string
  relativePath?: string
  action: RewindFileAction
  /** 当前版本与目标版本的可验证标识；缺失时不能执行破坏性动作。 */
  currentRevision?: string
  targetRevision?: string
  /** Immutable D1 object references for the current and target versions. */
  currentBackupRef?: string
  targetBackupRef?: string
  evidence: 'tracked-write' | 'checkpoint' | 'backup' | 'none'
  reason?: string
}

export interface RewindRevision {
  session: number
  files: number
  /** 计划生成后每次状态变化都必须使 revision 单调递增。 */
  state: number
}

export interface RewindCapabilityReport {
  runtime: AgentRuntime
  supportsConversation: boolean
  supportsFiles: boolean
  supportsBoth: boolean
  supportsUndo: boolean
  supportsRefine: boolean
  supportsSubmission: boolean
  reasons?: Partial<Record<'conversation' | 'files' | 'both' | 'undo' | 'refine' | 'submission', string>>
}

export interface RewindConversationPlan {
  /** 保留的最后一条产品消息；undefined 表示会话起点。 */
  keepThroughMessageUuid?: string
  /** 主进程解析出的逻辑轮次，不允许由 renderer 自行计算 resume 位。 */
  turnId?: string
  removedMessageUuids: string[]
  nativeResume?: { kind: 'claude' | 'pi'; resumeAt?: string }
}

export interface RewindPlan {
  protocolVersion: 1
  planId: string
  sessionId: string
  mode: RewindMode
  target: RewindTarget
  runtime: AgentRuntime
  createdAt: number
  revision: RewindRevision
  turnId?: string
  capability: RewindCapabilityReport
  conversation?: RewindConversationPlan
  files?: RewindFilePlanItem[]
  /**
   * 文件回退由工作区历史（Shadow Git）承担时要撤销的 turn，按时间正序。
   *
   * 不写进 `files[].targetRevision`：工作区历史不需要「目标版本的整份内容」，
   * 它在执行时按 before/after/current 三方合并现算，因此计划里也不该假装有目标内容。
   */
  shadowTurns?: string[]
}

export interface PrepareRewindPlanInput {
  sessionId: string
  mode: RewindMode
  target: RewindTarget
  expectedRevision?: RewindRevision
}

export interface PrepareRewindPlanResult {
  plan: RewindPlan
}

export interface ExecuteRewindPlanInput {
  sessionId: string
  planId: string
  expectedRevision: RewindRevision
}

export interface UndoRewindInput {
  sessionId: string
  recoveryId: string
  expectedRevision?: RewindRevision
}

export type RewindExecutionStatus = 'committed' | 'recovery-required' | 'rejected' | 'failed'

export interface RewindResult {
  status: RewindExecutionStatus
  sessionId: string
  planId: string
  recoveryId?: string
  revision: RewindRevision
  mode: RewindMode
  conversation?: { remainingMessages: number; turnId?: string }
  files?: { restored: string[]; deleted: string[]; conflicts: string[] }
}

/**
 * 回退成功后留给下一轮的一次性不可见上下文。
 *
 * 只保存「模型需要知道什么」，不保存文件内容或对象引用：真正的落盘结果已经在工作区里，
 * 模型应以磁盘当前内容为准。消费一次即清除（见 AgentSessionMeta.pendingRewindNotice）。
 */
export interface AgentRewindNotice {
  /** 产生时间（毫秒）。用于识别「这条 notice 属于哪次回退」，不参与判定。 */
  createdAt: number
  mode: RewindMode
  /** 已撤销（恢复）的文件数。 */
  restoredCount: number
  /** 已删除的文件数（Agent 新建后被撤销）。 */
  deletedCount: number
  /** 未能安全撤销、保持原样的文件路径（工作区相对路径，已去重排序）。 */
  keptPaths: string[]
  /** keptPaths 被截断前的真实总数。 */
  keptCount: number
}

export type RewindErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_LOADED'
  | 'PLAN_STALE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'EVIDENCE_UNAVAILABLE'
  | 'BACKUP_FAILED'
  | 'CONFLICT'
  | 'SUBMISSION_NOT_FOUND'
  | 'RECOVERY_REQUIRED'

export interface RewindErrorShape {
  code: RewindErrorCode
  message: string
  sessionId?: string
  planId?: string
  itemIds?: string[]
  details?: Record<string, unknown>
}

export interface RefineRewindPlanInput {
  sessionId: string
  previousPlanId: string
  /** 只允许排除前一个计划实际返回的 itemId，不能提交任意客户端路径。 */
  excludedItemIds: string[]
}

export interface SubmitAfterRewindInput {
  sessionId: string
  planId: string
  requestId: string
  submissionId: string
  /** 服务端已校验的草稿/原文引用。 */
  draftId: string
}

export interface SubmitAfterRewindResult {
  status: 'accepted' | 'dispatch-unknown' | 'failed'
  submissionId: string
  planId: string
  recoveryId?: string
  error?: RewindErrorShape
}

export interface RewindService {
  prepare(input: PrepareRewindPlanInput): Promise<PrepareRewindPlanResult>
  execute(input: ExecuteRewindPlanInput, callerKey?: string): Promise<RewindResult>
  undo(input: UndoRewindInput, callerKey?: string): Promise<RewindResult>
  refine(input: RefineRewindPlanInput): Promise<PrepareRewindPlanResult>
  submitAfterRewind(input: SubmitAfterRewindInput): Promise<SubmitAfterRewindResult>
  /** Durable caller binding used by the main-process gateway across restarts. */
  bindRecoveryOwner?(input: { sessionId: string; recoveryId: string; callerKey: string }): Promise<void>
}
