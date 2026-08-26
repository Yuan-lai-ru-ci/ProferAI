/**
 * Agent 内置协作会话工具
 *
 * 通过 SDK MCP Server 暴露 Profer Agent 子会话委派能力。
 * Skill 负责判断何时协作；这里负责受控创建真实 Agent 会话、运行、等待和停止。
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentMessage,
  AgentSessionMeta,
  AgentStreamPayload,
  AskUserRequest,
  PermissionRequest,
  ProferPermissionMode,
  SDKMessage,
} from '@profer/shared'
import { filterDisabledTools } from '@profer/shared'
import {
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  listAgentSessions,
  updateAgentSessionMeta,
} from './agent-session-manager'
import {
  runRegisteredHeadlessAgent,
  stopRegisteredAgent,
} from './agent-headless-runner-registry'
import {
  isAgentSessionActive,
  runAgentHeadless,
} from './agent-service'
import {
  MAX_RUNNING_DELEGATIONS_PER_PARENT,
  buildRecoveredDelegationState,
  buildDelegationTaskWithSharedContext,
  buildDelegationPrompt,
  resolveDelegationPermissionMode,
  type AgentDelegationRole,
  type AgentDelegationStatus,
} from './agent-collaboration-utils'
import { assertEnabledModelForChannel, listEnabledAgentModelsForChannel } from './agent-model-selection'

interface CollaborationToolContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  agentRuntime?: import('@profer/shared').AgentRuntime
  permissionMode?: ProferPermissionMode
  triggeredBy?: 'user' | 'automation' | 'delegation'
}

interface CollaborationToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
}

interface DelegationRecord {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  workspaceId?: string
  channelId: string
  modelId?: string
  title: string
  role: AgentDelegationRole
  goal: string
  permissionMode: ProferPermissionMode
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
  error?: string
  resultSummary?: string
  completion: Promise<void>
  resolveCompletion: () => void
}

type ZodModule = typeof import('zod')

const MAX_WAIT_SECONDS = 2 * 60 * 60
const DEFAULT_WAIT_SECONDS = 30 * 60
const RESULT_SUMMARY_CHAR_LIMIT = 12_000
const DELEGATION_GOAL_CHAR_LIMIT = 1_000
const MAX_RETAINED_FINISHED_DELEGATIONS = 200

const delegations = new Map<string, DelegationRecord>()

/**
 * 自动续跑按父会话串行：最后多个子会话可能几乎同时结束，锁确保只启动一轮父 Agent。
 * 已消费的委派 ID 不再触发同一批续跑；后续新委派仍可形成新批次。
 */
const parentAutoContinuationLocks = new Set<string>()
const autoContinuedDelegationIds = new Set<string>()
const AUTO_CONTINUATION_SUMMARY_LIMIT = 24_000

// ===== 阻塞事件追踪 =====

interface BlockedEvent {
  id: string
  delegationId: string
  childSessionId: string
  type: 'ask_user' | 'permission'
  askUserRequestId?: string
  askUserQuestions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }> }>
  permissionRequestId?: string
  permissionToolName?: string
  resolved: boolean
  createdAt: number
}

const blockedEvents = new Map<string, BlockedEvent>()

let _eventBusRegistered = false
let _eventBusRef: import('./agent-event-bus').AgentEventBus | null = null

export function registerCollaborationEventBus(eventBus: import('./agent-event-bus').AgentEventBus): void {
  if (_eventBusRegistered) return
  _eventBusRegistered = true
  _eventBusRef = eventBus

  eventBus.on((sessionId: string, payload: AgentStreamPayload) => {
    const record = Array.from(delegations.values()).find((d) => d.childSessionId === sessionId)
    if (!record || record.status !== 'running') return
    if (payload.kind !== 'profer_event') return

    const event = payload.event
    if (event.type === 'ask_user_request') {
      const req = event.request as AskUserRequest
      const blocked: BlockedEvent = {
        id: randomUUID(),
        delegationId: record.delegationId,
        childSessionId: sessionId,
        type: 'ask_user',
        askUserRequestId: req.requestId,
        askUserQuestions: req.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        })),
        resolved: false,
        createdAt: Date.now(),
      }
      blockedEvents.set(blocked.id, blocked)

      eventBus.emit(record.parentSessionId, {
        kind: 'profer_event',
        event: {
          type: 'delegation_blocked' as const,
          delegationId: record.delegationId,
          blockedEvent: blocked,
        } as unknown as import('@profer/shared').ProferEvent,
      })
    }

    if (event.type === 'permission_request') {
      const req = event.request as PermissionRequest
      const blocked: BlockedEvent = {
        id: randomUUID(),
        delegationId: record.delegationId,
        childSessionId: sessionId,
        type: 'permission',
        permissionRequestId: req.requestId,
        permissionToolName: req.toolName,
        resolved: false,
        createdAt: Date.now(),
      }
      blockedEvents.set(blocked.id, blocked)

      eventBus.emit(record.parentSessionId, {
        kind: 'profer_event',
        event: {
          type: 'delegation_blocked' as const,
          delegationId: record.delegationId,
          blockedEvent: blocked,
        } as unknown as import('@profer/shared').ProferEvent,
      })
    }

    if (event.type === 'ask_user_resolved' || event.type === 'permission_resolved') {
      const requestId = 'requestId' in event ? (event as { requestId: string }).requestId : undefined
      if (requestId) {
        for (const be of blockedEvents.values()) {
          if (be.resolved) continue
          if (be.askUserRequestId === requestId || be.permissionRequestId === requestId) {
            be.resolved = true
            break
          }
        }
      }
    }

    // 会话 run 结束（active 释放）：若该会话是某个父会话，重查自动续跑。
    // 堵住 #1313 竞态：父会话发起 delegation 后空闲等待，期间手动压缩占用了 active ownership，
    // 子会话完成触发的续跑被 parent_active 跳过；压缩 run 结束后发出此事件，在此重查并续跑。
    if (event.type === 'run_idle') {
      const parentSessionId = event.sessionId
      if (parentSessionId && isDelegationParent(parentSessionId)) {
        scheduleParentAutoContinuation(parentSessionId)
      }
    }
  })

  console.log('[协作工具] EventBus 阻塞事件监听已注册')
}

/** 该会话是否是某个委派的父会话（存在委派记录或存在 sourceDelegationId 的子会话） */
function isDelegationParent(parentSessionId: string): boolean {
  for (const record of delegations.values()) {
    if (record.parentSessionId === parentSessionId) return true
  }
  return listAgentSessions(true).some((s) => s.parentSessionId === parentSessionId)
}

function getPendingBlockedEvents(delegationId: string): BlockedEvent[] {
  return Array.from(blockedEvents.values()).filter((be) => be.delegationId === delegationId && !be.resolved)
}

function getBlockedEventById(blockedEventId: string): BlockedEvent | undefined {
  return blockedEvents.get(blockedEventId)
}

function pruneFinishedDelegations(): void {
  const finished = Array.from(delegations.values()).filter((item) => item.status !== 'running')
  const excess = finished.length - MAX_RETAINED_FINISHED_DELEGATIONS
  if (excess <= 0) return
  finished
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    .slice(0, excess)
    .forEach((item) => {
      delegations.delete(item.delegationId)
      autoContinuedDelegationIds.delete(item.delegationId)
    })
}

function jsonResult(payload: unknown): CollaborationToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function normalizeTitle(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim()
  if (trimmed) return trimmed.slice(0, 80)
  return fallback.slice(0, 80)
}

function truncateText(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[内容过长，已截断 ${text.length - limit} 字符]`
}

function assertNonBlank(value: string | undefined, field: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`${field} 不能为空`)
  }
  return trimmed
}

interface DelegateAgentArgs {
  title?: string
  role?: AgentDelegationRole
  task: string
  expectedOutput?: string
  permissionMode?: ProferPermissionMode
  modelId?: string
}

interface StartDelegationResult {
  record: DelegationRecord
  effectivePermissionMode: ProferPermissionMode
  effectiveModelId?: string
}

function getRunningDelegationCount(parentSessionId: string): number {
  return Array.from(delegations.values())
    .filter((item) => item.parentSessionId === parentSessionId && item.status === 'running')
    .length
}

/**
 * 返回当前进程中父会话是否仍有 live 协作子会话。
 *
 * 只读内存委派记录，不能以落盘 metadata 的旧 `running` 状态推断活跃任务；
 * 重启恢复时旧记录会被收敛为 interrupted。
 */
export function hasRunningDelegations(parentSessionId: string): boolean {
  return getRunningDelegationCount(parentSessionId) > 0
}

function createDelegationCompletion(): Pick<DelegationRecord, 'completion' | 'resolveCompletion'> {
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  return { completion, resolveCompletion }
}

function assertCanCreateDelegation(
  ctx: CollaborationToolContext,
  requestedCount = 1,
): AgentSessionMeta | undefined {
  const parent = getAgentSessionMeta(ctx.sessionId)
  const delegationDepth = parent?.delegationDepth ?? 0

  if (ctx.triggeredBy === 'delegation' || delegationDepth > 0) {
    throw new Error('协作子会话不能继续创建新的子会话')
  }

  const runningCount = getRunningDelegationCount(ctx.sessionId)
  if (runningCount + requestedCount > MAX_RUNNING_DELEGATIONS_PER_PARENT) {
    throw new Error(`当前父会话已有 ${runningCount} 个运行中的协作子会话，最多允许 ${MAX_RUNNING_DELEGATIONS_PER_PARENT} 个`)
  }

  if (!ctx.channelId) {
    throw new Error('创建协作子会话需要可用的 channelId')
  }
  if (!ctx.workspaceId) {
    throw new Error('创建协作子会话需要绑定工作区')
  }

  return parent
}

function extractTextFromSdkMessage(message: SDKMessage): string[] {
  const record = message as Record<string, unknown>
  if (record.type !== 'assistant') return []

  const outerMessage = record.message
  if (!outerMessage || typeof outerMessage !== 'object') return []

  const content = (outerMessage as Record<string, unknown>).content
  if (!Array.isArray(content)) return []

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockRecord = block as Record<string, unknown>
    if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') {
      parts.push(blockRecord.text)
    }
  }
  return parts
}

function summarizeChildResult(childSessionId: string, messages?: AgentMessage[]): string {
  const lastAssistant = [...(messages ?? [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim().length > 0)
  if (lastAssistant) return truncateText(lastAssistant.content.trim(), RESULT_SUMMARY_CHAR_LIMIT)

  const sdkMessages = getAgentSessionSDKMessages(childSessionId)
  const sdkTexts: string[] = []
  for (const message of sdkMessages) {
    sdkTexts.push(...extractTextFromSdkMessage(message))
  }
  const text = sdkTexts.join('\n\n').trim()
  if (text) return truncateText(text, RESULT_SUMMARY_CHAR_LIMIT)

  return '子会话已结束，但未找到可摘要的 assistant 文本。请打开子会话查看完整记录。'
}

function markDelegationFinished(
  record: DelegationRecord,
  status: AgentDelegationStatus,
  fields: { error?: string; resultSummary?: string } = {},
): void {
  if (record.status !== 'running') return
  record.status = status
  record.completedAt = Date.now()
  record.error = fields.error
  record.resultSummary = fields.resultSummary
  const child = updateAgentSessionMeta(record.childSessionId, { delegationStatus: status })
  // 完成状态必须推回父会话所属的渲染进程。不能只依赖随后可能陈旧的全量列表刷新，
  // 否则子会话可能暂时丢失委派字段，被侧栏当作普通会话展示。
  _eventBusRef?.emit(record.parentSessionId, {
    kind: 'profer_event',
    event: {
      type: 'delegation_session_updated',
      session: child,
    },
  })
  record.resolveCompletion()
  scheduleParentAutoContinuation(record.parentSessionId)
}

function buildParentAutoContinuationPrompt(records: DelegationRecord[]): string {
  const summaries = records.map((record) => {
    const detail = record.status === 'failed'
      ? `错误：${record.error || '未知错误'}`
      : record.resultSummary || '子会话未返回可摘要的 assistant 文本。'
    return `### ${record.title}\n- 委派 ID：${record.delegationId}\n- 状态：${record.status}\n${truncateText(detail, RESULT_SUMMARY_CHAR_LIMIT)}`
  }).join('\n\n')

  return truncateText(
    `所有协作子会话均已结束。请基于下列结果继续完成用户的原始任务；核验子会话的结论，不要把未验证内容当作事实。\n\n${summaries}`,
    AUTO_CONTINUATION_SUMMARY_LIMIT,
  )
}

/** 在同一父会话的全部 live 委派结束后，启动一轮携带结果的父会话。 */
function scheduleParentAutoContinuation(parentSessionId: string): void {
  if (parentAutoContinuationLocks.has(parentSessionId)) return
  const parentRecords = Array.from(delegations.values())
    .filter((record) => record.parentSessionId === parentSessionId)
  if (parentRecords.some((record) => record.status === 'running')) return

  const completed = parentRecords.filter((record) => !autoContinuedDelegationIds.has(record.delegationId))
  if (completed.length === 0) return

  const parent = getAgentSessionMeta(parentSessionId)
  // 历史会话可能缺少渠道；无渠道无法安全启动父会话，必须跳过而非将 undefined 传入运行器。
  if (!parent || !parent.channelId || parent.stoppedByUser || isAgentSessionActive(parentSessionId)) {
    console.info('[协作] 跳过父会话自动续跑', {
      parentSessionId,
      reason: !parent
        ? 'parent_missing'
        : !parent.channelId
          ? 'parent_channel_missing'
          : parent.stoppedByUser
            ? 'stopped_by_user'
            : 'parent_active',
    })
    return
  }

  parentAutoContinuationLocks.add(parentSessionId)
  completed.forEach((record) => autoContinuedDelegationIds.add(record.delegationId))
  // 自动续跑需要走 agent-service 的 headless 包装，而不是只调用底层 runner：
  // 前者会为父会话注册当前 renderer、发 external_run_started、转发流事件并发送
  // STREAM_COMPLETE。否则内容虽已落盘，但当前打开的父会话只能在切换回来后才重读到。
  runAgentHeadless(
    {
      sessionId: parentSessionId,
      userMessage: buildParentAutoContinuationPrompt(completed),
      channelId: parent.channelId,
      modelId: parent.modelId,
      workspaceId: parent.workspaceId,
      permissionModeOverride: parent.permissionMode,
      agentRuntime: parent.agentRuntime,
      // 父会话恢复后仍应能继续委派；delegation 标记会禁止协作工具。
      triggeredBy: 'user',
      startedAt: Date.now(),
    },
    {
      source: 'delegation',
      onError: (error) => {
        console.error(`[协作] 父会话自动续跑失败: parentSessionId=${parentSessionId}`, error)
      },
      onComplete: () => {
        parentAutoContinuationLocks.delete(parentSessionId)
        // 锁窗口期间若又有子会话恰好完成（markDelegationFinished 因锁被跳过），
        // 释放锁后必须复查一次，否则该子会话结果永远不会被父会话接收。
        scheduleParentAutoContinuation(parentSessionId)
      },
      onTitleUpdated: () => {},
    },
  ).catch((error: unknown) => {
    console.error(`[协作] 启动父会话自动续跑失败: parentSessionId=${parentSessionId}`, error)
    parentAutoContinuationLocks.delete(parentSessionId)
    // 与 onComplete 同理：启动失败也复查，避免漏收锁窗口内完成的子会话。
    scheduleParentAutoContinuation(parentSessionId)
  })
}

function getDelegationSummary(record: DelegationRecord): Record<string, unknown> {
  return {
    delegationId: record.delegationId,
    parentSessionId: record.parentSessionId,
    childSessionId: record.childSessionId,
    channelId: record.channelId,
    modelId: record.modelId,
    title: record.title,
    role: record.role,
    goal: record.goal,
    permissionMode: record.permissionMode,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    error: record.error,
    resultSummary: record.resultSummary,
    pendingBlockedEvents: getPendingBlockedEvents(record.delegationId),
  }
}

function listKnownDelegations(parentSessionId: string): Array<Record<string, unknown>> {
  const live = Array.from(delegations.values())
    .filter((item) => item.parentSessionId === parentSessionId)
    .map(getDelegationSummary)

  const liveIds = new Set(live.map((item) => item.delegationId))
  const persisted = listAgentSessions(true)
    .filter((session) => session.parentSessionId === parentSessionId && session.sourceDelegationId && !liveIds.has(session.sourceDelegationId))
    .map((session) => ({
      delegationId: session.sourceDelegationId,
      parentSessionId,
      childSessionId: session.id,
      channelId: session.channelId,
      modelId: session.modelId,
      title: session.title,
      role: session.delegationRole,
      goal: session.delegationGoal,
      permissionMode: session.permissionMode,
      status: session.delegationStatus,
      startedAt: session.createdAt,
      completedAt: session.delegationStatus && session.delegationStatus !== 'running' ? session.updatedAt : undefined,
    }))

  return [...live, ...persisted]
}

function getDelegationResult(parentSessionId: string, delegationId: string): Record<string, unknown> {
  const live = delegations.get(delegationId)
  if (live) {
    if (live.parentSessionId !== parentSessionId) {
      throw new Error(`委派不属于当前父会话: ${delegationId}`)
    }
    return getDelegationSummary(live)
  }

  const session = getPersistedDelegationSession(parentSessionId, delegationId)
  if (!session) {
    throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  }

  const resultSummary = session.delegationStatus && session.delegationStatus !== 'running'
    ? summarizeChildResult(session.id)
    : undefined

  return {
    delegationId,
    parentSessionId: session.parentSessionId ?? parentSessionId,
    childSessionId: session.id,
    channelId: session.channelId,
    modelId: session.modelId,
    title: session.title,
    role: session.delegationRole,
    goal: session.delegationGoal,
    permissionMode: session.permissionMode,
    status: session.delegationStatus,
    startedAt: session.createdAt,
    completedAt: session.delegationStatus && session.delegationStatus !== 'running' ? session.updatedAt : undefined,
    resultSummary,
  }
}

function findPersistedDelegationSessions(delegationId: string): AgentSessionMeta[] {
  return listAgentSessions(true)
    .filter((item) => item.sourceDelegationId === delegationId)
}

function getPersistedDelegationSession(parentSessionId: string, delegationId: string): AgentSessionMeta | undefined {
  const sessions = findPersistedDelegationSessions(delegationId)
  const scoped = sessions.find((item) => item.parentSessionId === parentSessionId)
  if (scoped) return scoped

  if (sessions.length !== 1) return undefined
  const unique = sessions[0]
  if (!unique) return undefined
  if (unique.parentSessionId == null || unique.parentSessionId === parentSessionId) {
    return unique
  }
  return undefined
}

function recoverDelegationRecordFromSession(
  parentSessionId: string,
  delegationId: string,
  session: AgentSessionMeta,
  fallbackPermissionMode: ProferPermissionMode | undefined,
  fallbackChannelId: string,
  fallbackModelId: string | undefined,
): DelegationRecord {
  const state = buildRecoveredDelegationState({
    parentSessionId: session.parentSessionId ?? parentSessionId,
    delegationId,
    session,
    fallbackPermissionMode,
  })
  const completionHandle = createDelegationCompletion()
  const record: DelegationRecord = {
    ...state,
    channelId: session.channelId ?? fallbackChannelId,
    modelId: session.modelId ?? fallbackModelId,
    ...completionHandle,
  }
  if (record.status !== 'running') {
    record.resolveCompletion()
    delegations.set(delegationId, record)
  }
  return record
}

function getDelegationRecordForContinuation(
  ctx: CollaborationToolContext,
  delegationId: string,
): DelegationRecord | undefined {
  const live = delegations.get(delegationId)
  if (live) {
    if (live.parentSessionId !== ctx.sessionId) {
      throw new Error(`委派不属于当前父会话: ${delegationId}`)
    }
    return live
  }

  const session = getPersistedDelegationSession(ctx.sessionId, delegationId)
  if (!session) return undefined
  return recoverDelegationRecordFromSession(ctx.sessionId, delegationId, session, ctx.permissionMode, ctx.channelId, ctx.modelId)
}

interface WaitResolution {
  liveRecords: DelegationRecord[]
  settled: Array<Record<string, unknown>>
}

function resolveWaitTargets(ids: string[], parentSessionId: string): WaitResolution {
  const liveRecords: DelegationRecord[] = []
  const settled: Array<Record<string, unknown>> = []
  for (const id of ids) {
    const record = delegations.get(id)
    if (record) {
      if (record.parentSessionId !== parentSessionId) {
        throw new Error(`委派不属于当前父会话: ${id}`)
      }
      liveRecords.push(record)
      continue
    }
    settled.push(getDelegationResult(parentSessionId, id))
  }
  return { liveRecords, settled }
}

function getFinishedDelegationCount(records: DelegationRecord[]): number {
  return records.filter((record) => record.status !== 'running').length
}

async function waitForLiveRecords(
  records: DelegationRecord[],
  timeoutSeconds: number,
  liveTarget: number,
): Promise<'completed' | 'timeout'> {
  if (getFinishedDelegationCount(records) >= liveTarget) {
    return 'completed'
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<'completed'>((resolve) => {
        const check = () => {
          if (getFinishedDelegationCount(records) >= liveTarget) {
            resolve('completed')
          }
        }
        for (const record of records) {
          if (record.status === 'running') {
            record.completion.then(check)
          }
        }
      }),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutSeconds * 1000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function getCurrentParentPermissionMode(
  parent: AgentSessionMeta | undefined,
  fallback: ProferPermissionMode | undefined,
): ProferPermissionMode | undefined {
  const latestParent = parent ? getAgentSessionMeta(parent.id) : undefined
  return latestParent?.permissionMode ?? parent?.permissionMode ?? fallback
}

function getAvailableAgentModels(ctx: CollaborationToolContext): Record<string, unknown> {
  const currentModelId = ctx.modelId?.trim() || undefined
  const summary = listEnabledAgentModelsForChannel(ctx.channelId, '读取协作子会话可用模型')
  return {
    channelId: summary.channelId,
    channelName: summary.channelName,
    provider: summary.provider,
    currentModelId,
    currentModelAvailable: currentModelId
      ? summary.models.some((model) => model.id === currentModelId)
      : false,
    models: summary.models.map((model) => ({
      ...model,
      current: model.id === currentModelId,
    })),
    modelCount: summary.models.length,
    note: summary.models.length > 0
      ? '创建协作子会话时，可从 models[].id 中选择 modelId；不传则继承 currentModelId。'
      : '当前渠道没有启用的 Agent 模型，请先在渠道设置中启用模型。',
  }
}

function stopDelegation(parentSessionId: string, delegationId: string): Record<string, unknown> {
  const record = delegations.get(delegationId)
  if (!record) {
    return {
      delegation: getDelegationResult(parentSessionId, delegationId),
      stopped: false,
      note: '该委派不在当前运行内存中（可能因应用重启已中断），无法主动停止。',
    }
  }
  if (record.parentSessionId !== parentSessionId) {
    throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  }
  if (record.status !== 'running') {
    return {
      delegation: getDelegationSummary(record),
      stopped: false,
    }
  }

  // 由父协作工具取消子会话并非 child UI 的直接 user stop。
  stopRegisteredAgent(record.childSessionId, 'delegation_cancel')
  markDelegationFinished(record, 'cancelled')
  return {
    delegation: getDelegationSummary(record),
    stopped: true,
  }
}

/**
 * 停止指定父会话的所有运行中子会话（级联取消）
 *
 * 当用户在 UI 停止父 Agent 时，其委派的协作子会话也应一并停止。
 * 此函数由 AgentOrchestrator.stop() 调用，确保级联取消。
 *
 * @returns 实际停止的子会话数量
 */
export function stopDelegationsForParent(parentSessionId: string): number {
  let stopped = 0
  for (const record of delegations.values()) {
    if (record.parentSessionId === parentSessionId && record.status === 'running') {
      try {
        stopRegisteredAgent(record.childSessionId, 'delegation_cancel')
        markDelegationFinished(record, 'cancelled')
        stopped++
      } catch (err) {
        console.error(`[协作] 级联停止子会话失败: delegationId=${record.delegationId}`, err)
      }
    }
  }
  if (stopped > 0) {
    console.log(`[协作] 已级联停止 ${stopped} 个协作子会话 (父会话: ${parentSessionId})`)
  }
  return stopped
}

function startDelegation(
  ctx: CollaborationToolContext,
  parent: AgentSessionMeta | undefined,
  args: DelegateAgentArgs,
): StartDelegationResult {
  const task = assertNonBlank(args.task, 'task')
  const delegationId = randomUUID()
  const role = args.role ?? 'custom'
  const title = normalizeTitle(args.title, `协作：${task}`)
  const goal = truncateText(task, DELEGATION_GOAL_CHAR_LIMIT)
  const parentPermissionMode = getCurrentParentPermissionMode(parent, ctx.permissionMode)
  const permissionMode = resolveDelegationPermissionMode(
    parentPermissionMode,
    args.permissionMode,
    ctx.agentRuntime ?? parent?.agentRuntime,
  )
  const effectiveModelId = args.modelId !== undefined
    ? assertEnabledModelForChannel({
        channelId: ctx.channelId,
        modelId: args.modelId,
        purpose: '创建协作子会话',
      })
    : ctx.modelId?.trim() || undefined

  const { completion, resolveCompletion } = createDelegationCompletion()

  // 创建真实子会话是用户对该项目会话的明确操作：先晋升隐藏父会话，
  // 避免正式子会话挂在不可见父节点下而无法从项目树访问。
  const effectiveParent = parent?.draft
    ? updateAgentSessionMeta(parent.id, { draft: false })
    : parent
  // 优先从持久化父会话继承，旧会话/无父上下文才安全回退 Claude。
  const inheritedRuntime = effectiveParent?.agentRuntime ?? ctx.agentRuntime ?? 'claude'
  // 会话持久化后的工作区是唯一权威来源。工具调用上下文可能来自已切换项目的旧流，
  // 不能让它把子会话创建或执行到另一个项目中。
  const workspaceId = effectiveParent?.workspaceId ?? ctx.workspaceId
  // 子会话必须继承父会话预设，避免受限父预设静默回退为 standard。
  const child = createAgentSession(
    title,
    ctx.channelId,
    workspaceId,
    effectiveModelId,
    inheritedRuntime,
    false,
    effectiveParent?.presetId,
  )
  const rootSessionId = effectiveParent?.rootSessionId ?? effectiveParent?.id ?? ctx.sessionId
  updateAgentSessionMeta(child.id, {
    parentSessionId: ctx.sessionId,
    rootSessionId,
    sourceDelegationId: delegationId,
    // 继承父会话的定时任务来源，保留自动化血缘；前端以 sourceDelegationId 优先
    // 展示委派徽章，不会被误判为定时任务（#993）。
    sourceAutomationId: effectiveParent?.sourceAutomationId,
    delegationRole: role,
    delegationStatus: 'running',
    delegationDepth: (parent?.delegationDepth ?? 0) + 1,
    delegationGoal: goal,
    permissionMode,
  })

  const record: DelegationRecord = {
    delegationId,
    parentSessionId: ctx.sessionId,
    childSessionId: child.id,
    workspaceId,
    channelId: ctx.channelId,
    modelId: effectiveModelId,
    title,
    role,
    goal,
    permissionMode,
    status: 'running',
    startedAt: Date.now(),
    completion,
    resolveCompletion,
  }
  delegations.set(delegationId, record)
  pruneFinishedDelegations()

  const prompt = buildDelegationPrompt({
    parentSessionId: ctx.sessionId,
    delegationId,
    role,
    task,
    expectedOutput: args.expectedOutput,
  })

  runRegisteredHeadlessAgent(
    {
      sessionId: child.id,
      userMessage: prompt,
      channelId: ctx.channelId,
      modelId: effectiveModelId,
      workspaceId,
      permissionModeOverride: permissionMode,
      triggeredBy: 'delegation',
      startedAt: record.startedAt,
    },
    {
      source: 'delegation',
      onError: (error) => {
        markDelegationFinished(record, 'failed', { error })
      },
      onComplete: (messages) => {
        // 级联取消会预先写入 cancelled；该状态仅阻断重复 delegation 收尾，
        // 不能阻断 agent-service 对同一 run 的权威 STREAM_COMPLETE 转发。
        if (record.status === 'running') {
          const resultSummary = summarizeChildResult(child.id, messages)
          markDelegationFinished(record, 'completed', { resultSummary })
        }
      },
      onTitleUpdated: (updatedTitle) => {
        record.title = updatedTitle
      },
    },
  ).catch((error: unknown) => {
    markDelegationFinished(record, 'failed', {
      error: error instanceof Error ? error.message : '未知错误',
    })
  })

  return { record, effectivePermissionMode: permissionMode, effectiveModelId }
}

function buildCollaborationSchemas(z: ZodModule['z']) {
  const nonBlankString = z.string().trim().min(1)
  const role = z.enum(['explore', 'research', 'implement', 'review', 'custom'])
  const permissionMode = z.enum(['plan', 'auto', 'bypassPermissions'])
  const delegateItem = z.object({
    title: z.string().optional().describe('子会话标题，简短说明子任务'),
    role: role.optional().describe('子任务角色：explore/research/implement/review/custom'),
    task: nonBlankString.describe('发送给子 Agent 的完整任务说明，必须自包含必要上下文'),
    expectedOutput: z.string().optional().describe('希望子 Agent 最终返回的格式或要点'),
    permissionMode: permissionMode.optional().describe('子会话权限模式；不能高于父会话权限'),
    modelId: nonBlankString.optional().describe('可选目标模型 ID；必须属于父会话当前渠道且已启用。不传则继承父会话当前模型'),
  })
  return {
    availableModels: {},
    delegate: {
      title: z.string().optional().describe('子会话标题，简短说明子任务'),
      role: role.optional().describe('子任务角色：explore/research/implement/review/custom'),
      task: nonBlankString.describe('发送给子 Agent 的完整任务说明，必须自包含必要上下文'),
      expectedOutput: z.string().optional().describe('希望子 Agent 最终返回的格式或要点'),
      permissionMode: permissionMode.optional().describe('子会话权限模式；不能高于父会话权限'),
      modelId: nonBlankString.optional().describe('可选目标模型 ID；必须属于父会话当前渠道且已启用。不传则继承父会话当前模型'),
    },
    delegateBatch: {
      sharedContext: z.string().optional().describe('批量子任务共用背景，会自动拼接到每个子任务前'),
      items: z.array(delegateItem).min(1).max(MAX_RUNNING_DELEGATIONS_PER_PARENT).describe('要创建的子会话列表，最多 50 个'),
    },
    wait: {
      delegationIds: z.array(z.string()).optional().describe('要等待的委派 ID；不传则等待当前父会话当前运行中的全部委派'),
      mode: z.enum(['all', 'any']).optional().describe('等待模式：all 等全部完成，any 等至少 minCompleted 个完成'),
      minCompleted: z.number().int().min(1).max(MAX_RUNNING_DELEGATIONS_PER_PARENT).optional().describe('mode=any 时至少等待完成的数量，默认 1'),
      timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe('最长等待秒数，默认 1800，最大 7200'),
    },
    list: {
      includeCompleted: z.boolean().optional().describe('是否包含已完成委派，默认 true'),
    },
    results: {
      delegationIds: z.array(z.string()).min(1).max(MAX_RUNNING_DELEGATIONS_PER_PARENT).describe('要读取结果的委派 ID 列表'),
    },
    stop: {
      delegationId: z.string().describe('要停止的委派 ID'),
    },
    stopBatch: {
      delegationIds: z.array(z.string()).min(1).max(MAX_RUNNING_DELEGATIONS_PER_PARENT).describe('要停止的委派 ID 列表'),
    },
    answer: {
      delegationId: nonBlankString.describe('子会话所属的委派 ID'),
      blockedEventId: nonBlankString.describe('要回答的阻塞事件 ID（从 delegation 的 pendingBlockedEvents 中获取）'),
      answers: z.record(z.string(), z.string()).optional().describe('AskUserQuestion 的回答（问题文本 → 答案文本）'),
      permissionBehavior: z.enum(['allow', 'deny']).optional().describe('Permission 请求的回复行为，默认 allow'),
    },
    continueD: {
      delegationId: nonBlankString.describe('要继续操作的委派 ID（必须是已完成/已失败/已取消状态）'),
      message: nonBlankString.describe('追加给子 Agent 的后续指令'),
    },
  }
}

export async function injectAgentCollaborationMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: CollaborationToolContext,
  disabledTools?: string[],
): Promise<void> {
  // Electron ASAR 环境下动态 ESM import 可能间歇性失败（Issue #1108），
  // 回退到 CommonJS require 兜底，避免 MCP 工具族在会话中途消失。
  let z: ZodModule['z']
  try {
    ({ z } = await import('zod') as ZodModule)
  } catch {
    z = require('zod').z
  }
  const schemas = buildCollaborationSchemas(z)

  const tools = [
      sdk.tool(
        'list_available_agent_models',
        '列出当前父会话渠道下已启用、可用于协作子 Agent 的模型。需要给 delegate_agent/delegate_agents 指定 modelId 前应先调用此工具。',
        schemas.availableModels,
        async () => {
          return jsonResult(getAvailableAgentModels(ctx))
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'delegate_agent',
        '创建一个真实可见的 Profer 协作子 Agent 会话来并行处理独立子任务。只用于长耗时、可并行、需要追踪的任务；简单搜索优先用内置 Agent/SubAgent。',
        schemas.delegate,
        async (args) => {
          const parent = assertCanCreateDelegation(ctx)
          const result = startDelegation(ctx, parent, args)

          return jsonResult({
            delegation: getDelegationSummary(result.record),
            effectivePermissionMode: result.effectivePermissionMode,
            effectiveModelId: result.effectiveModelId,
            note: '子会话已启动。需要结果时调用 wait_for_delegations。',
          })
        },
      ),
      sdk.tool(
        'delegate_agents',
        '批量创建多个真实可见的 Profer 协作子 Agent 会话。适合把同一大任务拆成多片并行处理，单个父会话运行中子会话最多 50 个。',
        schemas.delegateBatch,
        async (args) => {
          const parent = assertCanCreateDelegation(ctx, args.items.length)
          const created: StartDelegationResult[] = []
          const failures: Array<{ index: number; title?: string; error: string }> = []
          args.items.forEach((item, index) => {
            try {
              created.push(startDelegation(ctx, parent, {
                ...item,
                task: buildDelegationTaskWithSharedContext({
                  sharedContext: args.sharedContext,
                  task: item.task,
                }),
              }))
            } catch (error) {
              failures.push({
                index,
                title: item.title,
                error: error instanceof Error ? error.message : '未知错误',
              })
            }
          })

          return jsonResult({
            delegations: created.map((item) => getDelegationSummary(item.record)),
            effectivePermissionModes: created.map((item) => ({
              delegationId: item.record.delegationId,
              permissionMode: item.effectivePermissionMode,
            })),
            effectiveModels: created.map((item) => ({
              delegationId: item.record.delegationId,
              modelId: item.effectiveModelId,
            })),
            failures,
            createdCount: created.length,
            failedCount: failures.length,
            maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
            note: failures.length > 0
              ? `批量子会话部分创建成功（成功 ${created.length}，失败 ${failures.length}）。失败项可修正后重试；需要结果时调用 wait_for_delegations。`
              : '批量子会话已启动。需要结果时调用 wait_for_delegations，可用 mode=any 先收敛部分结果。',
          })
        },
      ),
      sdk.tool(
        'wait_for_delegations',
        '等待一个或多个 Profer 协作子会话完成，并返回结构化结果摘要。支持 all 等全部完成，或 any 等部分完成。',
        schemas.wait,
        async (args) => {
          const ids = args.delegationIds?.length
            ? args.delegationIds
            : Array.from(delegations.values())
              .filter((item) => item.parentSessionId === ctx.sessionId && item.status === 'running')
              .map((item) => item.delegationId)
          const { liveRecords, settled } = resolveWaitTargets(ids, ctx.sessionId)
          const totalTargets = liveRecords.length + settled.length
          if (totalTargets === 0) {
            return jsonResult({ delegations: [], note: '没有找到可等待的协作委派' })
          }

          const mode = args.mode ?? 'all'
          const minCompleted = args.minCompleted ?? 1
          const timeoutSeconds = Math.min(args.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)
          const targetCompleted = mode === 'all'
            ? totalTargets
            : Math.max(1, Math.min(minCompleted, totalTargets))
          const liveTarget = Math.max(0, targetCompleted - settled.length)
          const waitResult = liveRecords.length > 0
            ? await waitForLiveRecords(liveRecords, timeoutSeconds, liveTarget)
            : 'completed'

          const allDelegations = [...liveRecords.map(getDelegationSummary), ...settled]
          return jsonResult({
            status: waitResult,
            mode,
            completedCount: allDelegations.filter((item) => item.status !== 'running').length,
            runningCount: allDelegations.filter((item) => item.status === 'running').length,
            delegations: allDelegations,
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'list_delegations',
        '列出当前父会话创建的 Profer 协作子会话及状态。',
        schemas.list,
        async (args) => {
          const items = listKnownDelegations(ctx.sessionId)
          const delegationsResult = args.includeCompleted === false
            ? items.filter((item) => item.status === 'running')
            : items
          return jsonResult({
            maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
            runningCount: delegationsResult.filter((item) => item.status === 'running').length,
            delegations: delegationsResult,
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'get_delegation_results',
        '按委派 ID 读取一个或多个 Profer 协作子会话的结果摘要。适合先 list 后按需取结果，或父会话恢复后读取已完成子会话。',
        schemas.results,
        async (args) => {
          return jsonResult({
            delegations: args.delegationIds.map((delegationId) => getDelegationResult(ctx.sessionId, delegationId)),
          })
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'stop_delegation',
        '停止一个正在运行的 Profer 协作子会话。',
        schemas.stop,
        async (args) => {
          return jsonResult(stopDelegation(ctx.sessionId, args.delegationId))
        },
      ),
      sdk.tool(
        'stop_delegations',
        '批量停止多个正在运行的 Profer 协作子会话。',
        schemas.stopBatch,
        async (args) => {
          return jsonResult({
            results: args.delegationIds.map((delegationId) => stopDelegation(ctx.sessionId, delegationId)),
          })
        },
      ),
      sdk.tool(
        'answer_delegation_question',
        '代答协作子会话的阻塞问题（AskUserQuestion）或审批权限请求（Permission）。当子会话被阻塞时，父 Agent 可通过此工具代替用户回答，让子会话继续执行。从 delegation 的 pendingBlockedEvents 获取 blockedEventId。',
        schemas.answer,
        async (args) => {
          const blocked = getBlockedEventById(args.blockedEventId)
          if (!blocked) throw new Error(`阻塞事件不存在: ${args.blockedEventId}`)
          if (blocked.resolved) return jsonResult({ answered: false, note: '该阻塞事件已被解决' })

          const record = delegations.get(blocked.delegationId)
          if (record && record.parentSessionId !== ctx.sessionId) {
            throw new Error(`委派不属于当前父会话: ${blocked.delegationId}`)
          }

          if (blocked.type === 'ask_user' && blocked.askUserRequestId) {
            const { askUserService } = await import('./agent-ask-user-service')
            const answers = args.answers ?? {}
            const sessionId = await askUserService.respondToAskUser(blocked.askUserRequestId, answers)
            blocked.resolved = !!sessionId
            if (blocked.resolved && _eventBusRef) {
              _eventBusRef.emit(blocked.childSessionId, {
                kind: 'profer_event',
                event: { type: 'ask_user_resolved', requestId: blocked.askUserRequestId },
              })
            }
            return jsonResult({ answered: blocked.resolved, type: 'ask_user' })
          }

          if (blocked.type === 'permission' && blocked.permissionRequestId) {
            const { permissionService } = await import('./agent-permission-service')
            const behavior = args.permissionBehavior ?? 'allow'
            const sessionId = permissionService.respondToPermission(blocked.permissionRequestId, behavior, false)
            blocked.resolved = !!sessionId
            if (blocked.resolved && _eventBusRef) {
              _eventBusRef.emit(blocked.childSessionId, {
                kind: 'profer_event',
                event: { type: 'permission_resolved', requestId: blocked.permissionRequestId, behavior },
              })
            }
            return jsonResult({ answered: blocked.resolved, type: 'permission', behavior })
          }

          return jsonResult({ answered: false, note: '无法匹配阻塞事件类型' })
        },
      ),
      sdk.tool(
        'continue_delegation',
        '向已完成、已失败、已取消或已中断的协作子会话追加后续指令。子会话保留完整上下文继续执行。适合多轮协作场景：先让子 Agent 完成第一步，审查结果后继续下一步。',
        schemas.continueD,
        async (args) => {
          const record = getDelegationRecordForContinuation(ctx, args.delegationId)
          if (!record) throw new Error(`未找到当前会话下的委派: ${args.delegationId}`)
          if (record.status === 'running') {
            throw new Error(`委派正在运行中，无法追加指令。请先等待完成或停止后再继续: ${args.delegationId}`)
          }

          record.status = 'running'
          record.error = undefined
          record.resultSummary = undefined
          record.completedAt = undefined
          const completionHandle = createDelegationCompletion()
          record.completion = completionHandle.completion
          record.resolveCompletion = completionHandle.resolveCompletion

          const child = updateAgentSessionMeta(record.childSessionId, { delegationStatus: 'running' })

          const startedAt = Date.now()
          record.startedAt = startedAt

          runRegisteredHeadlessAgent(
            {
              sessionId: record.childSessionId,
              userMessage: args.message,
              channelId: record.channelId,
              modelId: record.modelId,
              workspaceId: child.workspaceId ?? record.workspaceId ?? ctx.workspaceId,
              permissionModeOverride: record.permissionMode,
              triggeredBy: 'delegation',
              startedAt,
            },
            {
              source: 'delegation',
              onError: (error) => {
                markDelegationFinished(record, 'failed', { error })
              },
              onComplete: (messages) => {
                if (record.status === 'running') {
                  const resultSummary = summarizeChildResult(record.childSessionId, messages)
                  markDelegationFinished(record, 'completed', { resultSummary })
                }
              },
              onTitleUpdated: () => {},
            },
          ).catch((error: unknown) => {
            markDelegationFinished(record, 'failed', {
              error: error instanceof Error ? error.message : '未知错误',
            })
          })

          const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DEFAULT_WAIT_SECONDS * 1000))
          await Promise.race([record.completion, timeout])

          return jsonResult({
            delegation: getDelegationSummary(record),
            note: record.status === 'running' ? '子会话仍在运行中（等待超时），可稍后用 wait_for_delegations 等待结果。' : undefined,
          })
        },
      ),
  ]

  const server = sdk.createSdkMcpServer({
    name: 'collaboration',
    version: '1.0.0',
    tools: filterDisabledTools(tools, disabledTools),
  })

  mcpServers.collaboration = server as unknown as Record<string, unknown>
  console.log('[Agent 编排] 已注入内置协作会话工具 (collaboration)')
}
export function buildPiCollaborationTools(
  sdk: typeof import('@earendil-works/pi-coding-agent'),
  ctx: CollaborationToolContext,
): unknown[] {
  const { Type } = require('typebox') as typeof import('typebox')

  const roleType = Type.Optional(Type.Union([
    Type.Literal('explore'),
    Type.Literal('research'),
    Type.Literal('implement'),
    Type.Literal('review'),
    Type.Literal('custom'),
  ], { description: '子任务角色' }))

  const permissionModeType = Type.Optional(Type.Union([
    Type.Literal('plan'),
    Type.Literal('auto'),
    Type.Literal('bypassPermissions'),
  ], { description: '子会话权限模式；不能高于父会话权限' }))

  const delegateItemType = Type.Object({
    title: Type.Optional(Type.String({ description: '子会话标题' })),
    role: roleType,
    task: Type.String({ description: '发送给子 Agent 的完整任务说明' }),
    expectedOutput: Type.Optional(Type.String({ description: '希望子 Agent 最终返回的格式或要点' })),
    permissionMode: permissionModeType,
    modelId: Type.Optional(Type.String({ description: '可选目标模型 ID' })),
  })

  function piJsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      details: payload,
    }
  }

  return [
    sdk.defineTool({
      name: 'mcp__collaboration__list_available_agent_models',
      label: '列出可用模型',
      description: '列出当前父会话渠道下已启用、可用于协作子 Agent 的模型。需要给 delegate_agent/delegate_agents 指定 modelId 前应先调用此工具。',
      parameters: Type.Object({}),
      async execute() {
        return piJsonResult(getAvailableAgentModels(ctx))
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__delegate_agent',
      label: '委派子 Agent',
      description: '创建一个真实可见的 Profer 协作子 Agent 会话来并行处理独立子任务。只用于长耗时、可并行、需要追踪的任务。',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: '子会话标题' })),
        role: roleType,
        task: Type.String({ description: '发送给子 Agent 的完整任务说明，必须自包含必要上下文' }),
        expectedOutput: Type.Optional(Type.String({ description: '希望子 Agent 最终返回的格式或要点' })),
        permissionMode: permissionModeType,
        modelId: Type.Optional(Type.String({ description: '可选目标模型 ID' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as DelegateAgentArgs
        const parent = assertCanCreateDelegation(ctx)
        const result = startDelegation(ctx, parent, args)
        return piJsonResult({
          delegation: getDelegationSummary(result.record),
          effectivePermissionMode: result.effectivePermissionMode,
          effectiveModelId: result.effectiveModelId,
          note: '子会话已启动。需要结果时调用 wait_for_delegations。',
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__delegate_agents',
      label: '批量委派子 Agent',
      description: '批量创建多个真实可见的 Profer 协作子 Agent 会话。适合把同一大任务拆成多片并行处理。',
      parameters: Type.Object({
        sharedContext: Type.Optional(Type.String({ description: '批量子任务共用背景' })),
        items: Type.Array(delegateItemType, { description: '要创建的子会话列表，最多 50 个' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { sharedContext?: string; items: DelegateAgentArgs[] }
        const parent = assertCanCreateDelegation(ctx, args.items.length)
        const created: StartDelegationResult[] = []
        const failures: Array<{ index: number; title?: string; error: string }> = []
        args.items.forEach((item, index) => {
          try {
            created.push(startDelegation(ctx, parent, {
              ...item,
              task: buildDelegationTaskWithSharedContext({
                sharedContext: args.sharedContext,
                task: item.task,
              }),
            }))
          } catch (error) {
            failures.push({
              index,
              title: item.title,
              error: error instanceof Error ? error.message : '未知错误',
            })
          }
        })
        return piJsonResult({
          delegations: created.map((item) => getDelegationSummary(item.record)),
          effectivePermissionModes: created.map((item) => ({
            delegationId: item.record.delegationId,
            permissionMode: item.effectivePermissionMode,
          })),
          effectiveModels: created.map((item) => ({
            delegationId: item.record.delegationId,
            modelId: item.effectiveModelId,
          })),
          failures,
          createdCount: created.length,
          failedCount: failures.length,
          maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__wait_for_delegations',
      label: '等待子会话完成',
      description: '等待一个或多个 Profer 协作子会话完成，并返回结构化结果摘要。',
      parameters: Type.Object({
        delegationIds: Type.Optional(Type.Array(Type.String(), { description: '要等待的委派 ID' })),
        mode: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('any')])),
        minCompleted: Type.Optional(Type.Number({ description: 'mode=any 时至少等待完成的数量，默认 1' })),
        timeoutSeconds: Type.Optional(Type.Number({ description: '最长等待秒数，默认 1800' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationIds?: string[]; mode?: 'all' | 'any'; minCompleted?: number; timeoutSeconds?: number }
        const ids = args.delegationIds?.length
          ? args.delegationIds
          : Array.from(delegations.values())
            .filter((item) => item.parentSessionId === ctx.sessionId && item.status === 'running')
            .map((item) => item.delegationId)
        const { liveRecords, settled } = resolveWaitTargets(ids, ctx.sessionId)
        const totalTargets = liveRecords.length + settled.length
        if (totalTargets === 0) {
          return piJsonResult({ delegations: [], note: '没有找到可等待的协作委派' })
        }
        const mode = args.mode ?? 'all'
        const minCompleted = args.minCompleted ?? 1
        const timeoutSeconds = Math.min(args.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS)
        const targetCompleted = mode === 'all' ? totalTargets : Math.max(1, Math.min(minCompleted, totalTargets))
        const liveTarget = Math.max(0, targetCompleted - settled.length)
        const waitResult = liveRecords.length > 0
          ? await waitForLiveRecords(liveRecords, timeoutSeconds, liveTarget)
          : 'completed'
        const allDelegations = [...liveRecords.map(getDelegationSummary), ...settled]
        return piJsonResult({
          status: waitResult,
          mode,
          completedCount: allDelegations.filter((item) => item.status !== 'running').length,
          runningCount: allDelegations.filter((item) => item.status === 'running').length,
          delegations: allDelegations,
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__list_delegations',
      label: '列出协作子会话',
      description: '列出当前父会话创建的 Profer 协作子会话及状态。',
      parameters: Type.Object({
        includeCompleted: Type.Optional(Type.Boolean({ description: '是否包含已完成委派，默认 true' })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { includeCompleted?: boolean }
        const items = listKnownDelegations(ctx.sessionId)
        const delegationsResult = args.includeCompleted === false
          ? items.filter((item) => item.status === 'running')
          : items
        return piJsonResult({
          maxRunningDelegations: MAX_RUNNING_DELEGATIONS_PER_PARENT,
          runningCount: delegationsResult.filter((item) => item.status === 'running').length,
          delegations: delegationsResult,
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__get_delegation_results',
      label: '读取子会话结果',
      description: '按委派 ID 读取一个或多个 Profer 协作子会话的结果摘要。',
      parameters: Type.Object({
        delegationIds: Type.Array(Type.String(), { description: '要读取结果的委派 ID 列表' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationIds: string[] }
        return piJsonResult({
          delegations: args.delegationIds.map((delegationId) => getDelegationResult(ctx.sessionId, delegationId)),
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__stop_delegation',
      label: '停止子会话',
      description: '停止一个正在运行的 Profer 协作子会话。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '要停止的委派 ID' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string }
        return piJsonResult(stopDelegation(ctx.sessionId, args.delegationId))
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__stop_delegations',
      label: '批量停止子会话',
      description: '批量停止多个正在运行的 Profer 协作子会话。',
      parameters: Type.Object({
        delegationIds: Type.Array(Type.String(), { description: '要停止的委派 ID 列表' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationIds: string[] }
        return piJsonResult({
          results: args.delegationIds.map((delegationId) => stopDelegation(ctx.sessionId, delegationId)),
        })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__answer_delegation_question',
      label: '代答子会话问题',
      description: '代答协作子会话的阻塞问题或审批权限请求。从 delegation 的 pendingBlockedEvents 获取 blockedEventId。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '子会话所属的委派 ID' }),
        blockedEventId: Type.String({ description: '要回答的阻塞事件 ID' }),
        answers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'AskUserQuestion 的回答' })),
        permissionBehavior: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('deny')])),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string; blockedEventId: string; answers?: Record<string, string>; permissionBehavior?: 'allow' | 'deny' }
        const blocked = getBlockedEventById(args.blockedEventId)
        if (!blocked) throw new Error(`阻塞事件不存在: ${args.blockedEventId}`)
        if (blocked.resolved) return piJsonResult({ answered: false, note: '该阻塞事件已被解决' })

        const record = delegations.get(blocked.delegationId)
        if (record && record.parentSessionId !== ctx.sessionId) {
          throw new Error(`委派不属于当前父会话: ${blocked.delegationId}`)
        }

        if (blocked.type === 'ask_user' && blocked.askUserRequestId) {
          const { askUserService } = await import('./agent-ask-user-service')
          const answers = args.answers ?? {}
          const sessionId = await askUserService.respondToAskUser(blocked.askUserRequestId, answers)
          blocked.resolved = !!sessionId
          if (blocked.resolved && _eventBusRef) {
            _eventBusRef.emit(blocked.childSessionId, {
              kind: 'profer_event',
              event: { type: 'ask_user_resolved', requestId: blocked.askUserRequestId },
            })
          }
          return piJsonResult({ answered: blocked.resolved, type: 'ask_user' })
        }

        if (blocked.type === 'permission' && blocked.permissionRequestId) {
          const { permissionService } = await import('./agent-permission-service')
          const behavior = args.permissionBehavior ?? 'allow'
          const sessionId = permissionService.respondToPermission(blocked.permissionRequestId, behavior, false)
          blocked.resolved = !!sessionId
          if (blocked.resolved && _eventBusRef) {
            _eventBusRef.emit(blocked.childSessionId, {
              kind: 'profer_event',
              event: { type: 'permission_resolved', requestId: blocked.permissionRequestId, behavior },
            })
          }
          return piJsonResult({ answered: blocked.resolved, type: 'permission', behavior })
        }

        return piJsonResult({ answered: false, note: '无法匹配阻塞事件类型' })
      },
    }),
    sdk.defineTool({
      name: 'mcp__collaboration__continue_delegation',
      label: '追加后续指令',
      description: '向已完成、已失败、已取消或已中断的协作子会话追加后续指令。子会话保留完整上下文继续执行。',
      parameters: Type.Object({
        delegationId: Type.String({ description: '要继续操作的委派 ID' }),
        message: Type.String({ description: '追加给子 Agent 的后续指令' }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const args = params as { delegationId: string; message: string }
        const record = getDelegationRecordForContinuation(ctx, args.delegationId)
        if (!record) throw new Error(`未找到当前会话下的委派: ${args.delegationId}`)
        if (record.status === 'running') {
          throw new Error(`委派正在运行中，无法追加指令: ${args.delegationId}`)
        }

        record.status = 'running'
        record.error = undefined
        record.resultSummary = undefined
        record.completedAt = undefined
        const completionHandle = createDelegationCompletion()
        record.completion = completionHandle.completion
        record.resolveCompletion = completionHandle.resolveCompletion

        const child = updateAgentSessionMeta(record.childSessionId, { delegationStatus: 'running' })

        const startedAt = Date.now()
        record.startedAt = startedAt

        runRegisteredHeadlessAgent(
          {
            sessionId: record.childSessionId,
            userMessage: args.message,
            channelId: record.channelId,
            modelId: record.modelId,
            workspaceId: child.workspaceId ?? record.workspaceId ?? ctx.workspaceId,
            permissionModeOverride: record.permissionMode,
            triggeredBy: 'delegation',
            startedAt,
          },
          {
            source: 'delegation',
            onError: (error) => {
              markDelegationFinished(record, 'failed', { error })
            },
            onComplete: (messages) => {
              if (record.status === 'running') {
                const resultSummary = summarizeChildResult(record.childSessionId, messages)
                markDelegationFinished(record, 'completed', { resultSummary })
              }
            },
            onTitleUpdated: () => {},
          },
        ).catch((error: unknown) => {
          markDelegationFinished(record, 'failed', {
            error: error instanceof Error ? error.message : '未知错误',
          })
        })

        const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DEFAULT_WAIT_SECONDS * 1000))
        await Promise.race([record.completion, timeout])

        return piJsonResult({
          delegation: getDelegationSummary(record),
          note: record.status === 'running' ? '子会话仍在运行中（等待超时），可稍后用 wait_for_delegations 等待结果。' : undefined,
        })
      },
    }),
  ]
}
