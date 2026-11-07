import { randomUUID } from 'node:crypto'
import type {
  AgentRuntime,
  ExecuteRewindPlanInput,
  PrepareRewindPlanInput,
  PrepareRewindPlanResult,
  RefineRewindPlanInput,
  RewindCapabilityReport,
  RewindErrorCode,
  RewindFilePlanItem,
  RewindMode,
  RewindPlan,
  RewindResult,
  RewindRevision,
  RewindService,
  RewindTarget,
  SubmitAfterRewindInput,
  SubmitAfterRewindResult,
  UndoRewindInput,
} from '@profer/shared'

type ConversationState = { messages: string[]; nativeResume: string }
type SessionState = ConversationState & { revision: RewindRevision; runtime?: AgentRuntime }
type FileState = { revision: string; value: string } | undefined

type ResolverFile = {
  itemId?: string
  path: string
  action: 'restore' | 'delete' | 'keep' | 'conflict'
  currentRevision?: string
  targetRevision?: string
  targetValue?: string
  rootId?: string
  relativePath?: string
  targetBackupRef?: string
  currentBackupRef?: string
  evidence?: 'tracked-write' | 'checkpoint' | 'backup' | 'none'
  reason?: string
}

export interface RewindResolverResult {
  conversation?: ConversationState
  files?: ResolverFile[]
  /** D2 adapters may expose provider-native naming; D4 normalizes it here. */
  fileCandidates?: ResolverFile[]
  supported?: boolean
  reason?: string
  runtime?: AgentRuntime
  capability?: Partial<RewindCapabilityReport>
}

/** Host adapters are injected so the service remains independent of renderer/provider SDKs. */
export interface RewindServicePorts {
  session: {
    read(sessionId: string): Promise<SessionState | undefined>
    resolveTarget(input: { sessionId: string; target: RewindTarget }): Promise<ConversationState | undefined>
    writeConversation(sessionId: string, value: ConversationState): Promise<void>
  }
  resolver: {
    resolve(input: { sessionId: string; mode: RewindMode; target: RewindTarget }): Promise<RewindResolverResult>
  }
  files: {
    read(path: string, scope?: { sessionId?: string; rootId?: string; relativePath?: string }): Promise<FileState>
    write(path: string, value: string | undefined, expectedRevision: string, scope?: { sessionId?: string; rootId?: string; relativePath?: string }): Promise<void>
    readBackup?(backupRef: string, sessionId?: string): Promise<string | undefined>
    authorizePath?(path: string, scope?: { sessionId?: string; rootId?: string; relativePath?: string }): Promise<void> | void
  }
  recovery: {
    backup(input: { sessionId: string; files: string[]; fileActions?: Array<{ rootId: string; relativePath: string; action: 'restore' | 'delete'; before: { revision: string; value?: string } | undefined; after: { revision: string; value?: string } | undefined; ownerKey?: string }>; messages: string[]; nativeResume: string; planId?: string; plan?: RewindPlan; expectedRevision?: RewindRevision; callerKey?: string }): Promise<string>
    journal(input: { sessionId?: string; recoveryId: string; status: 'applying' | 'recovery-required' | 'committed' }): Promise<void>
    retain(recoveryId: string): Promise<void>
    undo(sessionId: string, recoveryId: string, expectedRevision?: RewindRevision): Promise<void>
    /** Optional durable hooks. Hosts that provide them survive process restart. */
    persistPlan?(input: { sessionId: string; plan: RewindPlan; targetValues: Record<string, string | undefined>; targetBackupRefs: Record<string, string | undefined> }): Promise<void>
    readPlan?(sessionId: string, planId: string): Promise<{ plan: RewindPlan; targetValues: Record<string, string | undefined>; targetBackupRefs: Record<string, string | undefined> } | undefined>
    readRecovery?(sessionId: string, recoveryId: string): Promise<RecoveryRecord | undefined>
    updateRecovery?(input: { sessionId: string; recoveryId: string; patch: { status?: RewindResult['status']; result?: RewindResult; undone?: RewindResult } }): Promise<void>
    bindOwner?(input: { sessionId: string; recoveryId: string; callerKey: string }): Promise<void>
  }
  lock: { withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> }
  recoveryOwners?: Map<string, { sessionId: string; callerId: string }>
  runtime?: AgentRuntime
  submitAfterRewind?(input: SubmitAfterRewindInput & { recoveryId?: string }): Promise<SubmitAfterRewindResult>
}

interface PreparedPlan {
  plan: RewindPlan
  targetValues: Map<string, string | undefined>
  targetBackupRefs: Map<string, string | undefined>
}

interface RecoveryRecord {
  recoveryId: string
  sessionId: string
  planId: string
  mode: RewindMode
  status: RewindResult['status']
  result?: RewindResult
  undone?: RewindResult
  ownerKey?: string
}

class RewindServiceError extends Error {
  constructor(readonly code: RewindErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'RewindServiceError'
  }
}

function codeOf(error: unknown): RewindErrorCode | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code as RewindErrorCode : undefined
}

function throwMapped(error: unknown, fallback: RewindErrorCode, message: string): never {
  if (error instanceof RewindServiceError) throw error
  throw new RewindServiceError(codeOf(error) ?? fallback, error instanceof Error ? error.message : message)
}

function sameRevision(a: RewindRevision, b: RewindRevision): boolean {
  return a.session === b.session && a.files === b.files && a.state === b.state
}

function nextRevision(revision: RewindRevision, mode: RewindMode): RewindRevision {
  return {
    session: revision.session + (mode === 'conversation' || mode === 'both' ? 1 : 0),
    files: revision.files + (mode === 'files' || mode === 'both' ? 1 : 0),
    state: revision.state + 1,
  }
}

function assertRevision(expected: RewindRevision | undefined, actual: RewindRevision, details?: Record<string, unknown>): void {
  if (expected && !sameRevision(expected, actual)) throw new RewindServiceError('PLAN_STALE', '回退计划 revision 已过期', details)
}

function turnIdOf(target: RewindTarget): string | undefined {
  if (target.kind === 'after-turn') return target.turnId
  if (target.kind !== 'before-turn') return undefined
  const match = /^(.+?)(\d+)$/.exec(target.turnId)
  if (!match) return target.turnId
  const number = Number(match[2])
  return number > 0 ? `${match[1]}${number - 1}` : target.turnId
}

function fileScope(item: RewindFilePlanItem, sessionId: string): { sessionId: string; rootId?: string; relativePath?: string } {
  return {
    sessionId,
    ...(item.rootId === undefined ? {} : { rootId: item.rootId }),
    ...(item.relativePath === undefined ? {} : { relativePath: item.relativePath }),
  }
}

function makeCapability(runtime: AgentRuntime, mode: RewindMode, reason?: string): RewindCapabilityReport {
  return {
    runtime,
    supportsConversation: mode !== 'files',
    supportsFiles: mode !== 'conversation',
    supportsBoth: mode === 'both',
    supportsUndo: true,
    supportsRefine: true,
    supportsSubmission: true,
    ...(reason ? { reasons: { [mode]: reason } } : {}),
  }
}

function makeItem(item: ResolverFile, index: number): RewindFilePlanItem {
  return {
    itemId: item.itemId ?? `rewind-file-${index}-${item.path}`,
    path: item.path,
    ...(item.rootId === undefined ? {} : { rootId: item.rootId }),
    ...(item.relativePath === undefined ? {} : { relativePath: item.relativePath }),
    action: item.action,
    ...(item.currentRevision === undefined ? {} : { currentRevision: item.currentRevision }),
    ...(item.targetRevision === undefined ? {} : { targetRevision: item.targetRevision }),
    ...(item.currentBackupRef === undefined ? {} : { currentBackupRef: item.currentBackupRef }),
    ...(item.targetBackupRef === undefined ? {} : { targetBackupRef: item.targetBackupRef }),
    evidence: item.evidence ?? 'tracked-write',
    ...(item.reason ? { reason: item.reason } : {}),
  }
}

export function createAgentRewindService(options: { ports: RewindServicePorts }): RewindService {
  const ports = options.ports
  const plans = new Map<string, PreparedPlan>()
  const executions = new Map<string, RewindResult>()
  const recoveries = new Map<string, RecoveryRecord>()
  const submissions = new Map<string, Promise<SubmitAfterRewindResult>>()

  async function readSession(sessionId: string): Promise<SessionState> {
    let session: SessionState | undefined
    try { session = await ports.session.read(sessionId) }
    catch (error) { throwMapped(error, 'SESSION_NOT_FOUND', `Agent 会话不存在: ${sessionId}`) }
    if (!session) throw new RewindServiceError('SESSION_NOT_FOUND', `Agent 会话不存在: ${sessionId}`, { sessionId })
    return session
  }

  async function loadPlan(sessionId: string, planId: string): Promise<PreparedPlan | undefined> {
    const cached = plans.get(planId)
    if (cached && cached.plan.sessionId === sessionId) return cached
    if (!ports.recovery.readPlan) return undefined
    const saved = await ports.recovery.readPlan(sessionId, planId)
    if (!saved || saved.plan.sessionId !== sessionId) return undefined
    const prepared: PreparedPlan = {
      plan: saved.plan,
      targetValues: new Map(Object.entries(saved.targetValues)),
      targetBackupRefs: new Map(Object.entries(saved.targetBackupRefs)),
    }
    plans.set(planId, prepared)
    return prepared
  }

  async function loadRecovery(sessionId: string, recoveryId: string): Promise<RecoveryRecord | undefined> {
    const cached = recoveries.get(recoveryId)
    if (cached && cached.sessionId === sessionId) return cached
    if (!ports.recovery.readRecovery) return undefined
    const saved = await ports.recovery.readRecovery(sessionId, recoveryId)
    if (saved && saved.sessionId === sessionId) recoveries.set(recoveryId, saved)
    return saved
  }

  async function saveRecovery(record: RecoveryRecord, patch?: { status?: RewindResult['status']; result?: RewindResult; undone?: RewindResult }): Promise<void> {
    recoveries.set(record.recoveryId, record)
    if (ports.recovery.updateRecovery && patch) {
      await ports.recovery.updateRecovery({ sessionId: record.sessionId, recoveryId: record.recoveryId, patch })
    }
  }
  async function prepare(input: PrepareRewindPlanInput): Promise<PrepareRewindPlanResult> {
    const session = await readSession(input.sessionId)
    assertRevision(input.expectedRevision, session.revision, { sessionId: input.sessionId })

    let boundary: ConversationState | undefined
    if (input.mode !== 'files') {
      try { boundary = await ports.session.resolveTarget({ sessionId: input.sessionId, target: input.target }) }
      catch (error) { throwMapped(error, 'TARGET_NOT_FOUND', '回退目标无法解析') }
      if (!boundary) throw new RewindServiceError('TARGET_NOT_FOUND', '回退目标不存在或尚未加载', { sessionId: input.sessionId })
    }

    const runtime = ports.runtime ?? session.runtime ?? 'claude'

    let resolved: RewindResolverResult
    try {
      resolved = await ports.resolver.resolve({ sessionId: input.sessionId, mode: input.mode, target: input.target })
      // both is a product-level composition: ask the provider for each capability
      // as well, so a missing file resolver cannot be mistaken for conversation-only.
      if (input.mode === 'both') {
        const fileResolution = await ports.resolver.resolve({ sessionId: input.sessionId, mode: 'files', target: input.target })
        resolved = {
          ...resolved,
          files: resolved.files ?? fileResolution.files,
          capability: { ...resolved.capability, ...fileResolution.capability },
        }
      }
    } catch (error) {
      throwMapped(error, 'CAPABILITY_UNAVAILABLE', '回退 provider 能力不可用')
    }

    const resolvedRuntime = resolved.runtime ?? runtime
    const conversation = input.mode === 'files' ? undefined : resolved.conversation ?? boundary
    const rawFiles = input.mode === 'conversation' ? undefined : resolved.files ?? resolved.fileCandidates ?? []
    const unsupported = rawFiles?.find(item => (item.evidence ?? 'tracked-write') !== 'tracked-write')
    const fileItems = rawFiles?.map(makeItem)
    const reason = unsupported
      ? `文件证据不可用于自动恢复: ${unsupported.path}`
      : resolved.reason ?? resolved.capability?.reasons?.[input.mode]
    const supported = resolved.supported !== false && !reason && (input.mode === 'conversation'
      ? Boolean(conversation)
      : input.mode === 'files' ? Boolean(fileItems) : Boolean(conversation && fileItems))
    if (!supported) {
      const errorCode: RewindErrorCode = reason?.includes('证据') || reason?.includes('evidence')
        ? 'EVIDENCE_UNAVAILABLE' : 'CAPABILITY_UNAVAILABLE'
      throw new RewindServiceError(errorCode, reason ?? '回退能力不可用', { sessionId: input.sessionId })
    }

    const removedMessageUuids = conversation
      ? session.messages.filter(message => !conversation.messages.includes(message))
      : []
    const plan: RewindPlan = {
      protocolVersion: 1,
      planId: randomUUID(),
      sessionId: input.sessionId,
      mode: input.mode,
      target: input.target,
      runtime: resolvedRuntime,
      createdAt: Date.now(),
      revision: session.revision,
      ...(turnIdOf(input.target) ? { turnId: turnIdOf(input.target) } : {}),
      capability: resolved.capability ? { ...makeCapability(resolvedRuntime, input.mode), ...resolved.capability } : makeCapability(resolvedRuntime, input.mode),
      ...(conversation ? {
        conversation: {
          ...(conversation.messages.at(-1) ? { keepThroughMessageUuid: conversation.messages.at(-1) } : {}),
          ...(turnIdOf(input.target) ? { turnId: turnIdOf(input.target) } : {}),
          removedMessageUuids,
          nativeResume: { kind: resolvedRuntime, resumeAt: conversation.nativeResume },
        },
      } : {}),
      ...(fileItems ? { files: fileItems } : {}),
    }
    if (fileItems) {
      for (const item of fileItems) {
        if (item.action === 'keep') continue
        if (ports.files.authorizePath) {
          try { await ports.files.authorizePath(item.path, fileScope(item, input.sessionId)) }
          catch (error) { throwMapped(error, 'EVIDENCE_UNAVAILABLE', `文件路径未获授权: ${item.path}`) }
        }
      }
    }
    const targetValues = new Map<string, string | undefined>()
    const targetBackupRefs = new Map<string, string | undefined>()
    rawFiles?.forEach((item, index) => {
      const itemId = fileItems![index]!.itemId
      targetValues.set(itemId, item.targetValue)
      targetBackupRefs.set(itemId, item.targetBackupRef)
    })
    const prepared = { plan, targetValues, targetBackupRefs }
    plans.set(plan.planId, prepared)
    if (ports.recovery.persistPlan) {
      await ports.recovery.persistPlan({
        sessionId: input.sessionId,
        plan,
        targetValues: Object.fromEntries(targetValues),
        targetBackupRefs: Object.fromEntries(targetBackupRefs),
      })
    }
    return { plan }
  }

  async function execute(input: ExecuteRewindPlanInput, callerKey?: string): Promise<RewindResult> {
    const prior = executions.get(input.planId)
    if (prior) return prior
    const prepared = plans.get(input.planId) ?? await (async () => {
      const persisted = await ports.recovery.readPlan?.(input.sessionId, input.planId)
      if (!persisted) return undefined
      const restored: PreparedPlan = {
        plan: persisted.plan,
        targetValues: new Map(Object.entries(persisted.targetValues)),
        targetBackupRefs: new Map(Object.entries(persisted.targetBackupRefs)),
      }
      plans.set(input.planId, restored)
      return restored
    })()
    if (!prepared || prepared.plan.sessionId !== input.sessionId) {
      throw new RewindServiceError('PLAN_STALE', '回退计划不存在或不属于当前会话', { planId: input.planId })
    }
    const { plan, targetValues, targetBackupRefs } = prepared

    return ports.lock.withSessionLock(input.sessionId, async () => {
      const session = await readSession(input.sessionId)
      if (!sameRevision(plan.revision, input.expectedRevision) || !sameRevision(plan.revision, session.revision)) {
        throw new RewindServiceError('PLAN_STALE', '回退计划 revision 已过期', { planId: input.planId })
      }

      const files = plan.files ?? []
      const fileStates = new Map<string, FileState>()
      for (const item of files) {
        if (item.action === 'keep') continue
        if (item.action === 'conflict') throw new RewindServiceError('CONFLICT', `文件计划包含冲突: ${item.path}`, { itemIds: [item.itemId] })
        if (ports.files.authorizePath) {
          try { await ports.files.authorizePath(item.path, fileScope(item, input.sessionId)) }
          catch (error) { throwMapped(error, 'EVIDENCE_UNAVAILABLE', `文件路径未获授权: ${item.path}`) }
        }
        if (!item.currentRevision || !item.targetRevision || item.evidence !== 'tracked-write') {
          throw new RewindServiceError('EVIDENCE_UNAVAILABLE', `文件缺少可验证版本证据: ${item.path}`, { itemIds: [item.itemId] })
        }
        const current = await ports.files.read(item.path, fileScope(item, input.sessionId))
        fileStates.set(item.itemId, current)
        if ((current?.revision ?? 'absent') !== item.currentRevision) {
          throw new RewindServiceError('CONFLICT', `文件在预览后发生变化: ${item.path}`, { itemIds: [item.itemId] })
        }
      }

      const fileActions = [] as Array<{ rootId: string; relativePath: string; action: 'restore' | 'delete'; before: FileState; after: FileState; ownerKey?: string }>
      for (const item of files) {
        if (item.action === 'keep' || item.action === 'conflict') continue
        if (!item.rootId || !item.relativePath) throw new RewindServiceError('EVIDENCE_UNAVAILABLE', `文件证据缺少稳定路径标识: ${item.path}`)
        let after: FileState
        if (item.action === 'delete') after = undefined
        else {
          let value = targetValues.get(item.itemId)
          const ref = targetBackupRefs.get(item.itemId)
          if (value === undefined && ref && ports.files.readBackup) value = await ports.files.readBackup(ref, input.sessionId)
          if (value === undefined) throw new RewindServiceError('EVIDENCE_UNAVAILABLE', `文件缺少目标内容: ${item.path}`)
          after = { revision: item.targetRevision!, value }
        }
        fileActions.push({ rootId: item.rootId, relativePath: item.relativePath, action: item.action, before: fileStates.get(item.itemId), after, ...(callerKey ? { ownerKey: callerKey } : {}) })
      }

      let recoveryId: string
      try {
        recoveryId = await ports.recovery.backup({
          sessionId: input.sessionId,
          files: files.map(item => item.path),
          fileActions,
          messages: session.messages,
          nativeResume: session.nativeResume,
          planId: plan.planId,
          plan,
          callerKey,
        })
        await ports.recovery.journal({ sessionId: input.sessionId, recoveryId, status: 'applying' })
      } catch (error) {
        throwMapped(error, 'BACKUP_FAILED', '无法在破坏性写入前保存回退恢复副本')
      }

      const restored: string[] = []
      const deleted: string[] = []
      const conflicts: string[] = []
      try {
        for (const item of files) {
          if (item.action === 'keep') continue
          const current = await ports.files.read(item.path, fileScope(item, input.sessionId))
          const expected = fileStates.get(item.itemId)?.revision ?? 'absent'
          if ((current?.revision ?? 'absent') !== expected) {
            conflicts.push(item.itemId)
            throw new RewindServiceError('CONFLICT', `文件在执行期间发生变化: ${item.path}`, { itemIds: conflicts })
          }
          let targetValue = targetValues.get(item.itemId)
          const targetBackupRef = targetBackupRefs.get(item.itemId)
          if (item.action === 'restore' && targetValue === undefined && targetBackupRef && ports.files.readBackup) {
            targetValue = await ports.files.readBackup(targetBackupRef, input.sessionId)
          }
          if (item.action === 'restore' && targetValue === undefined) {
            throw new RewindServiceError('EVIDENCE_UNAVAILABLE', `文件缺少目标内容: ${item.path}`, { itemIds: [item.itemId] })
          }
          await ports.files.write(item.path, item.action === 'delete' ? undefined : targetValue, expected, fileScope(item, input.sessionId))
          if (item.action === 'delete') deleted.push(item.path)
          else if (item.action === 'restore') restored.push(item.path)
        }

        if (plan.conversation) {
          const boundary = await ports.session.resolveTarget({ sessionId: input.sessionId, target: plan.target })
          if (!boundary) throw new RewindServiceError('TARGET_NOT_FOUND', '执行时回退目标已不可用')
          await ports.session.writeConversation(input.sessionId, boundary)
        }
        await ports.recovery.journal({ sessionId: input.sessionId, recoveryId, status: 'committed' })
        const result: RewindResult = {
          status: 'committed', sessionId: input.sessionId, planId: plan.planId, recoveryId,
          revision: nextRevision(plan.revision, plan.mode), mode: plan.mode,
          ...(plan.conversation ? {
            conversation: {
              remainingMessages: session.messages.length - plan.conversation.removedMessageUuids.length,
              ...(plan.turnId ? { turnId: plan.turnId } : {}),
            },
          } : {}),
          ...(plan.files ? { files: { restored, deleted, conflicts } } : {}),
        }
        executions.set(input.planId, result)
        recoveries.set(recoveryId, { recoveryId, sessionId: input.sessionId, planId: plan.planId, mode: plan.mode, status: result.status, result })
        await ports.recovery.updateRecovery?.({ sessionId: input.sessionId, recoveryId, patch: { status: result.status, result } })
        return result
      } catch (error) {
        try {
          await ports.recovery.journal({ sessionId: input.sessionId, recoveryId, status: 'recovery-required' })
          await ports.recovery.retain(recoveryId)
        } catch {
          // 保留原始业务错误；恢复记录仍由宿主在重启后发现。
        }
        if (codeOf(error) === 'CONFLICT' && restored.length === 0 && deleted.length === 0) throw error
        const result: RewindResult = {
          status: 'recovery-required', sessionId: input.sessionId, planId: plan.planId,
          recoveryId, revision: plan.revision, mode: plan.mode,
          ...(plan.files ? { files: { restored, deleted, conflicts } } : {}),
        }
        recoveries.set(recoveryId, { recoveryId, sessionId: input.sessionId, planId: plan.planId, mode: plan.mode, status: result.status, result })
        await ports.recovery.updateRecovery?.({ sessionId: input.sessionId, recoveryId, patch: { status: result.status, result } })
        return result
      }
    })
  }

  async function bindRecoveryOwner(input: { sessionId: string; recoveryId: string; callerKey: string }): Promise<void> {
    await ports.recovery.bindOwner?.(input)
    const record = await ports.recovery.readRecovery?.(input.sessionId, input.recoveryId)
    if (record) recoveries.set(input.recoveryId, record)
  }

  async function undo(input: UndoRewindInput, callerKey?: string): Promise<RewindResult> {
    const record = recoveries.get(input.recoveryId) ?? await ports.recovery.readRecovery?.(input.sessionId, input.recoveryId)
    if (!record || record.sessionId !== input.sessionId) {
      throw new RewindServiceError('RECOVERY_REQUIRED', '恢复记录不存在或不属于当前会话', { sessionId: input.sessionId })
    }
    if (record.ownerKey && record.ownerKey !== callerKey) throw new RewindServiceError('RECOVERY_REQUIRED', '恢复记录不属于当前调用方')
    const owner = ports.recoveryOwners?.get(input.recoveryId)
    if (owner && (owner.sessionId !== input.sessionId || owner.callerId !== callerKey)) throw new RewindServiceError('RECOVERY_REQUIRED', '恢复记录不属于当前调用方')

    if (record.undone) return record.undone
    return ports.lock.withSessionLock(input.sessionId, async () => {
      const session = await readSession(input.sessionId)
      assertRevision(input.expectedRevision, session.revision, { recoveryId: input.recoveryId })
      try { await ports.recovery.undo(input.sessionId, input.recoveryId, session.revision) }
      catch (error) { throwMapped(error, 'RECOVERY_REQUIRED', '恢复记录撤销失败') }
      const result: RewindResult = {
        status: 'committed', sessionId: input.sessionId, planId: record.planId,
        recoveryId: input.recoveryId, revision: nextRevision(session.revision, record.mode), mode: record.mode,
      }
      record.undone = result
      await ports.recovery.updateRecovery?.({ sessionId: input.sessionId, recoveryId: input.recoveryId, patch: { undone: result } })
      return result
    })
  }

  async function refine(input: RefineRewindPlanInput): Promise<PrepareRewindPlanResult> {
    const previous = plans.get(input.previousPlanId)
    if (!previous || previous.plan.sessionId !== input.sessionId) throw new RewindServiceError('PLAN_STALE', '原回退计划不存在或不属于当前会话')
    const known = new Set((previous.plan.files ?? []).map(item => item.itemId))
    if (input.excludedItemIds.some(itemId => !known.has(itemId))) throw new RewindServiceError('TARGET_NOT_FOUND', 'excludedItemIds 不属于原回退计划')
    const prepared = await prepare({ sessionId: input.sessionId, mode: previous.plan.mode, target: previous.plan.target, expectedRevision: previous.plan.revision })
    if (prepared.plan.files) prepared.plan.files = prepared.plan.files.filter(item => !input.excludedItemIds.includes(item.itemId))
    return prepared
  }

  async function submitAfterRewind(input: SubmitAfterRewindInput): Promise<SubmitAfterRewindResult> {
    const plan = plans.get(input.planId)?.plan
    if (!plan || plan.sessionId !== input.sessionId) {
      return { status: 'failed', submissionId: input.submissionId, planId: input.planId, error: { code: 'SUBMISSION_NOT_FOUND', message: '回退计划不存在', sessionId: input.sessionId, planId: input.planId } }
    }
    const key = `${input.sessionId}:${input.requestId}:${input.submissionId}`
    const existing = submissions.get(key)
    if (existing) return existing
    const operation = ports.submitAfterRewind
      ? ports.submitAfterRewind(input)
      : Promise.resolve({ status: 'failed' as const, submissionId: input.submissionId, planId: input.planId, error: { code: 'SUBMISSION_NOT_FOUND' as const, message: '未注入重发提交端口', sessionId: input.sessionId, planId: input.planId } })
    submissions.set(key, operation)
    return operation
  }

  return { prepare, execute, undo, refine, submitAfterRewind, bindRecoveryOwner }
}
