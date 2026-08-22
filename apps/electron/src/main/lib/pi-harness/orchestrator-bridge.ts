import { randomUUID } from 'node:crypto'
import type { ProferPermissionMode, SDKMessage } from '@profer/shared'
import { appendGraphEvent, loadHarnessGraphSnapshot } from '../project-graph-service'
import { getReadyTasks, type TaskNode } from '@profer/project-core'
import { appendPiHarnessEvent, loadPiHarnessSnapshot } from './pi-harness-store'
import { buildGraphFocusPacket } from './graph-focus-packet'
import { decideGoalIntake } from './goal-controller'
import { createToolFact, type ToolFactInput } from './tool-facts'
import { reconcileFocusedTask, shouldPersistVerificationDecision } from './reconciler'
import { decideShadowGovernorCandidate } from './governor'
import type { PiHarnessGoal, PiHarnessPolicySnapshot, PiTurnUsage } from './types'
import type { PiHarnessLifecycleEvent } from '../adapters/pi-harness-lifecycle'

export interface PiHarnessRunScope {
  readonly sessionId: string
  readonly goalId: string
  readonly turnId: string
  readonly activeTaskId?: string
  readonly prompt: string
  observeLifecycle(event: PiHarnessLifecycleEvent): void
  observeResult(message: SDKMessage): void
  observeToolResult(input: ToolFactInput): void
  pause(reason: string): void
  settle(outcome: 'completed' | 'failed'): void
}

const activeScopes = new Map<string, PiHarnessRunScope>()

interface ManualCandidateContinuationTicket {
  id: string
  sessionId: string
  goalId: string
  taskId: string
  candidateFingerprint: string
  userMessage: string
}

/**
 * Tickets exist only in main-process memory between a user click and the normal
 * Agent send path. They are not prompt text, IPC input, sidecar state, or an
 * autonomous scheduling queue.
 */
const manualCandidateContinuationTickets = new Map<string, ManualCandidateContinuationTicket>()

function latestManualCandidate(snapshot: ReturnType<typeof loadPiHarnessSnapshot>, sessionId: string, taskId: string): ManualCandidateContinuationTicket | undefined {
  const graph = loadHarnessGraphSnapshot(sessionId).graph
  const task = graph.nodes[taskId]
  if (!task || !getReadyTasks(graph).some((candidate) => candidate.id === taskId)) return undefined
  const candidate = [...snapshot.governorCandidates]
    .filter((item) => item.taskId === taskId
      && item.action === 'ready_task'
      && item.blockedReason === 'shadow_mode'
      && !snapshot.manuallyContinuedCandidateFingerprints.includes(item.fingerprint)
      && snapshot.goals[item.goalId]?.state === 'active'
      && snapshot.goals[item.goalId]?.policy.governorMode === 'shadow')
    .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))[0]
  if (!candidate) return undefined
  return {
    id: randomUUID(),
    sessionId,
    goalId: candidate.goalId,
    taskId,
    candidateFingerprint: candidate.fingerprint,
    userMessage: buildManualCandidateContinuationMessage(task),
  }
}

function clipped(value: string, maxChars: number): string {
  const safe = value
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|prelay)_[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...safe]
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/** The visible user instruction is deliberately finite and task-only. */
function buildManualCandidateContinuationMessage(task: TaskNode): string {
  const description = clipped(task.description, 600)
  return [
    `继续 Project Graph 中已就绪的任务：${clipped(task.subject, 180)}`,
    description ? `任务说明：${description}` : '',
    '这是用户明确选择的后续任务。仅聚焦该任务；如需改变方向，请先向用户说明。',
  ].filter(Boolean).join('\n')
}

/**
 * Revalidates a renderer-nominated task against Graph + sidecar and reserves a
 * one-shot main-process ticket. This has no model or queue side effect.
 */
export function prepareManualPiHarnessCandidateContinuation(sessionId: string, taskId: string): { ticketId: string; userMessage: string } {
  if (activeScopes.has(sessionId)) throw new Error('会话仍在处理中，暂不能继续候选任务')
  if ([...manualCandidateContinuationTickets.values()].some((ticket) => ticket.sessionId === sessionId && ticket.taskId === taskId)) {
    throw new Error('该候选任务正在启动，请勿重复继续')
  }
  const candidate = latestManualCandidate(loadPiHarnessSnapshot(sessionId), sessionId, taskId)
  if (!candidate) throw new Error('该任务不是可继续的就绪候选，或候选已失效')
  manualCandidateContinuationTickets.set(candidate.id, candidate)
  return { ticketId: candidate.id, userMessage: candidate.userMessage }
}

/** Releases an unconsumed ticket after the normal send path rejects or ends. */
export function releaseManualPiHarnessCandidateContinuation(ticketId: string): void {
  manualCandidateContinuationTickets.delete(ticketId)
}

function takeManualCandidateContinuation(ticketId: string | undefined, sessionId: string): ManualCandidateContinuationTicket | undefined {
  if (!ticketId) return undefined
  const ticket = manualCandidateContinuationTickets.get(ticketId)
  if (!ticket || ticket.sessionId !== sessionId) return undefined
  manualCandidateContinuationTickets.delete(ticketId)
  // The interval from explicit user click to Pi start has no active Agent run;
  // nevertheless re-read deterministic state before consuming the candidate.
  const current = latestManualCandidate(loadPiHarnessSnapshot(sessionId), sessionId, ticket.taskId)
  if (!current || current.goalId !== ticket.goalId || current.candidateFingerprint !== ticket.candidateFingerprint) return undefined
  return ticket
}

function policy(permissionMode: ProferPermissionMode): PiHarnessPolicySnapshot {
  return { governorMode: 'shadow', permissionMode, maxFocusChars: 1_200 }
}

function latestRunnableGoal(goals: Record<string, PiHarnessGoal>): PiHarnessGoal | undefined {
  return Object.values(goals)
    .filter((goal) => goal.state === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0]
}

function usageFromResult(message: SDKMessage, previous: PiTurnUsage): PiTurnUsage {
  if (message.type !== 'result') return previous
  const usage = (message as { usage?: { input_tokens?: unknown; output_tokens?: unknown }; total_cost_usd?: unknown }).usage
  return {
    ...previous,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : previous.inputTokens,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : previous.outputTokens,
  }
}

function createScope(options: {
  sessionId: string
  goalId: string
  turnId: string
  activeTaskId?: string
  prompt: string
}): PiHarnessRunScope {
  let paused = false
  let settled = false
  const startedAt = Date.now()
  let usage: PiTurnUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    retries: 0,
    compactions: 0,
    durationMs: 0,
  }
  // A tool result can only exist after the model has emitted the matching tool
  // call. Pi emits `agent_end` as the normal model-call accounting signal, but
  // a user Stop may cut off that terminal lifecycle event after tools have run.
  // Preserve a one-call lower bound for that interrupted path, then consume the
  // next lifecycle confirmation instead of double-counting it.
  let inferredUnconfirmedModelCall = false
  const appendState = (state: 'running' | 'retrying' | 'compacting' | 'settled' | 'interrupted' | 'failed', endReason?: string): void => {
    usage = { ...usage, durationMs: Math.max(0, Date.now() - startedAt) }
    appendPiHarnessEvent(options.sessionId, {
      version: 1,
      eventId: randomUUID(),
      timestamp: Date.now(),
      sessionId: options.sessionId,
      goalId: options.goalId,
      turnId: options.turnId,
      type: 'turn_state_changed',
      payload: { state, ...(endReason ? { endReason } : {}), usage },
    })
  }

  const reconcileAndRecordShadow = (): void => {
    const graph = loadHarnessGraphSnapshot(options.sessionId, options.activeTaskId).graph
    const snapshot = loadPiHarnessSnapshot(options.sessionId)
    const previous = options.activeTaskId ? snapshot.verificationByTask[options.activeTaskId] : undefined
    const decision = reconcileFocusedTask({
      graph,
      taskId: options.activeTaskId,
      facts: Object.values(snapshot.facts),
      previous,
    })
    if (decision && shouldPersistVerificationDecision(decision, previous)) {
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId: options.goalId,
        taskId: decision.taskId,
        type: 'verification_state_changed',
        payload: { state: decision.state, reason: decision.reason, evidenceFactIds: decision.evidenceFactIds },
      })
    }

    const afterReconcile = loadPiHarnessSnapshot(options.sessionId)
    const goal = afterReconcile.goals[options.goalId]
    const assurance = options.activeTaskId ? afterReconcile.verificationByTask[options.activeTaskId] : undefined
    if (!goal) return
    const candidate = decideShadowGovernorCandidate({
      graph,
      goal,
      assurance,
      facts: Object.values(afterReconcile.facts),
      existingFingerprints: new Set(afterReconcile.governorCandidateFingerprints),
    })
    if (!candidate) return
    appendPiHarnessEvent(options.sessionId, {
      version: 1,
      eventId: randomUUID(),
      timestamp: Date.now(),
      sessionId: options.sessionId,
      goalId: options.goalId,
      ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
      type: 'governor_candidate_recorded',
      payload: {
        action: candidate.action,
        reason: candidate.reason,
        blockedReason: candidate.blockedReason,
        estimatedPromptChars: candidate.estimatedPromptChars,
        fingerprint: candidate.fingerprint,
      },
    })
  }

  return {
    ...options,
    observeLifecycle(event) {
      if (settled || paused) return
      switch (event.type) {
        case 'turn_running': appendState('running'); break
        case 'model_call_completed':
          if (inferredUnconfirmedModelCall) {
            inferredUnconfirmedModelCall = false
          } else {
            usage = { ...usage, modelCalls: usage.modelCalls + 1 }
          }
          break
        case 'retry_started':
          usage = { ...usage, retries: usage.retries + 1 }
          appendState('retrying')
          break
        case 'retry_finished': appendState('running'); break
        case 'compaction_started':
          usage = { ...usage, compactions: usage.compactions + 1 }
          appendState('compacting')
          break
        case 'compaction_finished': appendState('running'); break
      }
    },
    observeResult(message) {
      usage = usageFromResult(message, usage)
    },
    observeToolResult(input) {
      if (settled || paused) return
      const fact = createToolFact({ goalId: options.goalId, turnId: options.turnId, taskId: options.activeTaskId }, input)
      if (!fact) return
      if (usage.modelCalls === 0) {
        usage = { ...usage, modelCalls: 1 }
        inferredUnconfirmedModelCall = true
      }
      const existing = loadPiHarnessSnapshot(options.sessionId)
      if (Object.values(existing.facts).some((item) => item.fingerprint === fact.fingerprint)) return
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId: options.goalId,
        turnId: options.turnId,
        type: 'tool_fact_recorded',
        payload: { fact },
      })
    },
    pause(reason) {
      if (paused || settled) return
      paused = true
      appendState('interrupted', reason)
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId: options.goalId,
        type: 'goal_paused',
        payload: { reason },
      })
    },
    settle(outcome) {
      if (settled || paused) return
      settled = true
      try {
        reconcileAndRecordShadow()
      } catch (error) {
        // Evidence/Governor are observability-only during shadow rollout. The
        // caller still settles the current Pi Turn even if reconciliation fails.
        console.warn('[Pi Harness] reconcile/shadow governor 失败，忽略:', error)
      }
      appendState(outcome === 'completed' ? 'settled' : 'failed', outcome)
      // A user-level Pi Turn settling does not imply the project Goal settled.
      // Keep the Goal active for a later user-driven continuation; Phase 3 never
      // schedules that continuation itself. Goal settlement belongs to a later
      // reconciler/governor decision backed by graph and evidence facts.
    },
  }
}

/**
 * Creates the Phase-3, feature-gated Pi control scope. It never schedules a
 * second query: all sidecar writes are observations of the current user Turn.
 */
export function startPiHarnessRun(options: {
  sessionId: string
  userMessage: string
  prompt: string
  permissionMode: ProferPermissionMode
  /** Internal one-shot ticket created only by the protected manual-continuation IPC. */
  manualCandidateContinuationTicket?: string
}): PiHarnessRunScope | undefined {
  if (options.userMessage.trim() === '/compact') return undefined

  const manual = takeManualCandidateContinuation(options.manualCandidateContinuationTicket, options.sessionId)
  if (options.manualCandidateContinuationTicket && !manual) {
    throw new Error('候选任务已失效，请刷新任务图后重试')
  }
  const before = loadPiHarnessSnapshot(options.sessionId)
  const existingGoal = manual ? before.goals[manual.goalId] : latestRunnableGoal(before.goals)
  let graphSnapshot = loadHarnessGraphSnapshot(options.sessionId, manual?.taskId ?? existingGoal?.activeTaskId)
  const decision = manual ? undefined : decideGoalIntake({
    userMessage: options.userMessage,
    graph: graphSnapshot.graph,
    previousFocusTaskId: existingGoal?.activeTaskId,
  })
  if (decision?.kind === 'manual_compact') return undefined

  let rootTaskId: string | undefined
  if (!existingGoal && decision?.kind === 'minimal_root' && decision.rootTask) {
    rootTaskId = randomUUID()
    appendGraphEvent(options.sessionId, {
      type: 'task_created',
      taskId: rootTaskId,
      timestamp: Date.now(),
      payload: { subject: decision.rootTask.subject, description: decision.rootTask.description, dependsOn: [] },
    })
    graphSnapshot = loadHarnessGraphSnapshot(options.sessionId)
  }

  const selectedTaskId = manual?.taskId ?? graphSnapshot.focusTaskId
  const goalId = existingGoal?.id ?? randomUUID()
  if (!existingGoal) {
    appendPiHarnessEvent(options.sessionId, {
      version: 1,
      eventId: randomUUID(),
      timestamp: Date.now(),
      sessionId: options.sessionId,
      goalId,
      type: 'goal_created',
      payload: { rootTaskId, activeTaskId: selectedTaskId, policy: policy(options.permissionMode) },
    })
  }
  if (manual) {
    appendPiHarnessEvent(options.sessionId, {
      version: 1,
      eventId: randomUUID(),
      timestamp: Date.now(),
      sessionId: options.sessionId,
      goalId,
      taskId: manual.taskId,
      type: 'manual_candidate_continued',
      payload: { candidateFingerprint: manual.candidateFingerprint },
    })
  }
  appendPiHarnessEvent(options.sessionId, {
    version: 1,
    eventId: randomUUID(),
    timestamp: Date.now(),
    sessionId: options.sessionId,
    goalId,
    type: 'task_focus_changed',
    payload: { activeTaskId: selectedTaskId, reason: manual ? '用户明确继续 shadow 候选任务' : graphSnapshot.focusReason },
  })

  const turnId = randomUUID()
  appendPiHarnessEvent(options.sessionId, {
    version: 1,
    eventId: randomUUID(),
    timestamp: Date.now(),
    sessionId: options.sessionId,
    goalId,
    turnId,
    type: 'turn_started',
    payload: { activeTaskId: selectedTaskId },
  })
  const current = loadPiHarnessSnapshot(options.sessionId)
  const goal = current.goals[goalId]
  const packet = buildGraphFocusPacket({
    graph: graphSnapshot.graph,
    ...(goal ? { goal } : {}),
    verificationByTask: current.verificationByTask,
  })
  const scope = createScope({
    sessionId: options.sessionId,
    goalId,
    turnId,
    activeTaskId: selectedTaskId,
    prompt: `${packet}\n\n${options.prompt}`,
  })
  activeScopes.set(options.sessionId, scope)
  return scope
}

export function pauseActivePiHarnessRun(sessionId: string, reason = 'user_stop'): void {
  const scope = activeScopes.get(sessionId)
  if (!scope) return
  try {
    scope.pause(reason)
  } finally {
    if (activeScopes.get(sessionId) === scope) activeScopes.delete(sessionId)
  }
}

export function settlePiHarnessRun(sessionId: string, outcome: 'completed' | 'failed'): void {
  const scope = activeScopes.get(sessionId)
  if (!scope) return
  try {
    scope.settle(outcome)
  } finally {
    if (activeScopes.get(sessionId) === scope) activeScopes.delete(sessionId)
  }
}

export function getActivePiHarnessRunForTest(sessionId: string): PiHarnessRunScope | undefined {
  return activeScopes.get(sessionId)
}

export function clearPiHarnessRunsForTest(): void {
  activeScopes.clear()
  manualCandidateContinuationTickets.clear()
}
