import type {
  ExecuteRewindPlanInput,
  PrepareRewindPlanInput,
  PrepareRewindPlanResult,
  RefineRewindPlanInput,
  RewindResult,
  RewindService,
  SubmitAfterRewindInput,
  SubmitAfterRewindResult,
  UndoRewindInput,
} from '@profer/shared'

export type RewindCaller = { kind: 'desktop' } | { kind: 'remote'; id: string }

type CallerKey = string

const MAX_ID_LENGTH = 200
let rewindService: RewindService | null = null
const planOwners = new Map<string, { sessionId: string; callerKey: CallerKey }>()
const recoveryOwners = new Map<string, { sessionId: string; callerKey: CallerKey }>()
const submissions = new Map<string, { fingerprint: string; operation: Promise<SubmitAfterRewindResult> }>()
const requestSubmissions = new Map<string, string>()
let authorizeRemoteFiles: ((sessionId: string, callerId: string) => boolean) | null = null

function callerKey(caller: RewindCaller): CallerKey {
  return caller.kind === 'desktop' ? 'desktop' : `remote:${caller.id}`
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH
}

function requireService(): RewindService {
  if (!rewindService) throw new Error('回退服务尚未就绪')
  return rewindService
}

export function setAgentRewindService(service: RewindService | null, options: { authorizeRemoteFiles?: (sessionId: string, callerId: string) => boolean } = {}): void {
  rewindService = service
  authorizeRemoteFiles = options.authorizeRemoteFiles ?? null
  planOwners.clear()
  recoveryOwners.clear()
  submissions.clear()
  requestSubmissions.clear()
}

export function validateRewindInput<T extends { sessionId: string }>(input: T): T {
  if (!input || !validId(input.sessionId)) throw new Error('无效 sessionId')
  return input
}

function bindPlan(result: PrepareRewindPlanResult, sessionId: string, caller: RewindCaller): PrepareRewindPlanResult {
  if (result.plan.sessionId !== sessionId || !validId(result.plan.planId)) throw new Error('回退服务返回了无效计划')
  planOwners.set(result.plan.planId, { sessionId, callerKey: callerKey(caller) })
  return result
}

function assertPlan(sessionId: string, planId: string, caller: RewindCaller): void {
  if (!validId(sessionId) || !validId(planId)) throw new Error('无效 sessionId 或 planId')
  const owner = planOwners.get(planId)
  if (!owner || owner.sessionId !== sessionId || owner.callerKey !== callerKey(caller)) {
    throw new Error('回退计划不存在、已失效或不属于当前调用方/会话')
  }
}

export async function prepareAgentRewind(input: PrepareRewindPlanInput, caller: RewindCaller): Promise<PrepareRewindPlanResult> {
  validateRewindInput(input)
  if (!['conversation', 'files', 'both'].includes(input.mode)) throw new Error('无效回退模式')
  if (caller.kind === 'remote' && input.mode !== 'conversation' && !authorizeRemoteFiles?.(input.sessionId, caller.id)) {
    throw new Error('远程文件回退未获服务端授权')
  }
  if (!input.target || !['after-turn', 'before-turn', 'message', 'session-start'].includes(input.target.kind)) throw new Error('无效回退目标')
  if (input.target.kind !== 'session-start') {
    const targetId = input.target.kind === 'message' ? input.target.messageUuid : input.target.turnId
    if (!validId(targetId)) throw new Error('回退目标缺少有效标识')
  }
  return bindPlan(await requireService().prepare(input), input.sessionId, caller)
}

export async function refineAgentRewind(input: RefineRewindPlanInput, caller: RewindCaller): Promise<PrepareRewindPlanResult> {
  validateRewindInput(input)
  assertPlan(input.sessionId, input.previousPlanId, caller)
  if (!Array.isArray(input.excludedItemIds) || input.excludedItemIds.some(id => !validId(id))) throw new Error('无效 excludedItemIds')
  return bindPlan(await requireService().refine(input), input.sessionId, caller)
}

export async function executeAgentRewind(input: ExecuteRewindPlanInput, caller: RewindCaller): Promise<RewindResult> {
  validateRewindInput(input)
  assertPlan(input.sessionId, input.planId, caller)
  const result = await requireService().execute(input, callerKey(caller))
  if (result.sessionId !== input.sessionId || result.planId !== input.planId) throw new Error('回退服务结果与请求不匹配')
  if (result.recoveryId) {
    const owner = { sessionId: input.sessionId, callerKey: callerKey(caller) }
    recoveryOwners.set(result.recoveryId, owner)
    await requireService().bindRecoveryOwner?.({ ...owner, recoveryId: result.recoveryId })
  }
  return result
}

export async function undoAgentRewind(input: UndoRewindInput, caller: RewindCaller): Promise<RewindResult> {
  validateRewindInput(input)
  if (!validId(input.recoveryId)) throw new Error('无效 recoveryId')
  const owner = recoveryOwners.get(input.recoveryId)
  if (owner && (owner.sessionId !== input.sessionId || owner.callerKey !== callerKey(caller))) throw new Error('恢复记录不存在或不属于当前调用方/会话')
  return requireService().undo(input, callerKey(caller))
}

export async function submitAgentAfterRewind(input: SubmitAfterRewindInput, caller: RewindCaller): Promise<SubmitAfterRewindResult> {
  validateRewindInput(input)
  assertPlan(input.sessionId, input.planId, caller)
  if (![input.requestId, input.submissionId, input.draftId].every(validId)) throw new Error('无效 requestId、submissionId 或 draftId')
  const key = `${callerKey(caller)}:${input.sessionId}:${input.submissionId}`
  const requestKey = `${callerKey(caller)}:${input.sessionId}:${input.requestId}`
  const fingerprint = JSON.stringify(input)
  const existing = submissions.get(key)
  const requestSubmissionId = requestSubmissions.get(requestKey)
  if (requestSubmissionId && requestSubmissionId !== input.submissionId) throw new Error('requestId 已绑定其他 submissionId')
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('submissionId 已绑定其他请求内容')
    return existing.operation
  }
  const operation = requireService().submitAfterRewind(input).catch(() => ({
    status: 'dispatch-unknown' as const,
    submissionId: input.submissionId,
    planId: input.planId,
    error: { code: 'RECOVERY_REQUIRED' as const, message: '发送结果未知，需要对账后才能重试', sessionId: input.sessionId, planId: input.planId },
  }))
  submissions.set(key, { fingerprint, operation })
  requestSubmissions.set(requestKey, input.submissionId)
  return operation
}

export async function legacyConversationRewind(
  input: { sessionId: string; assistantMessageUuid?: string },
  caller: RewindCaller,
): Promise<RewindResult> {
  validateRewindInput(input)
  const prepared = await prepareAgentRewind({
    sessionId: input.sessionId,
    mode: 'conversation',
    target: input.assistantMessageUuid
      ? { kind: 'message', messageUuid: input.assistantMessageUuid }
      : { kind: 'session-start' },
  }, caller)
  return executeAgentRewind({
    sessionId: input.sessionId,
    planId: prepared.plan.planId,
    expectedRevision: prepared.plan.revision,
  }, caller)
}
