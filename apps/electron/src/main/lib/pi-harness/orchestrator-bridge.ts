import { randomUUID } from 'node:crypto'
import type { ProferPermissionMode } from '@profer/shared'
import { appendGraphEvent, loadHarnessGraphSnapshot } from '../project-graph-service'
import { appendPiHarnessEvent, loadPiHarnessSnapshot } from './pi-harness-store'
import { buildGraphFocusPacket } from './graph-focus-packet'
import { decideGoalIntake } from './goal-controller'
import type { PiHarnessGoal, PiHarnessPolicySnapshot } from './types'
import { createPiHarnessRunScope, type PiHarnessRunScope } from './run-scope'
import {
  clearManualContinuationTicketsForTest,
  prepareManualContinuationTicket,
  takeManualCandidateContinuation,
} from './manual-continuation'

export { releaseManualPiHarnessCandidateContinuation } from './manual-continuation'
export type { PiHarnessRunScope } from './run-scope'

export function prepareManualPiHarnessCandidateContinuation(sessionId: string, taskId: string): { ticketId: string; userMessage: string } {
  if (activeScopes.has(sessionId)) throw new Error('会话仍在处理中，暂不能继续候选任务')
  return prepareManualContinuationTicket(sessionId, taskId)
}

const activeScopes = new Map<string, PiHarnessRunScope>()

function policy(permissionMode: ProferPermissionMode): PiHarnessPolicySnapshot {
  return { governorMode: 'shadow', permissionMode, maxFocusChars: 1_200 }
}

function latestRunnableGoal(goals: Record<string, PiHarnessGoal>): PiHarnessGoal | undefined {
  return Object.values(goals)
    .filter((goal) => goal.state === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0]
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
  const policySnapshot = policy(options.permissionMode)
  // Build all potentially-throwing read/format state before appending lifecycle events.
  // This keeps a normal setup error from leaving a `turn_started` with no terminal state.
  const goalForPrompt: PiHarnessGoal = existingGoal ?? {
    id: goalId,
    sessionId: options.sessionId,
    rootTaskId,
    activeTaskId: selectedTaskId,
    state: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    policy: policySnapshot,
  }
  const packet = buildGraphFocusPacket({
    graph: graphSnapshot.graph,
    goal: goalForPrompt,
    verificationByTask: before.verificationByTask,
  })
  const turnId = randomUUID()
  const scope = createPiHarnessRunScope({
    sessionId: options.sessionId,
    goalId,
    turnId,
    activeTaskId: selectedTaskId,
    factFingerprints: new Set(Object.values(before.facts).map((fact) => fact.fingerprint)),
    prompt: `${packet}\n\n${options.prompt}`,
  })

  try {
    if (!existingGoal) {
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId,
        type: 'goal_created',
        payload: { rootTaskId, activeTaskId: selectedTaskId, policy: policySnapshot },
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
        payload: { candidateFingerprint: manual.candidateFingerprint },
        type: 'manual_candidate_continued',
      })
    }
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
  } catch (error) {
    // Best effort: if goal/turn events were already appended, close the turn as
    // failed instead of leaving an active-looking ledger entry. Preserve the
    // original setup error even if the diagnostic append also fails.
    try {
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId,
        turnId,
        type: 'turn_state_changed',
        payload: { state: 'failed', endReason: 'harness_setup_failed' },
      })
      appendPiHarnessEvent(options.sessionId, {
        version: 1,
        eventId: randomUUID(),
        timestamp: Date.now(),
        sessionId: options.sessionId,
        goalId,
        type: 'goal_paused',
        payload: { reason: 'harness_setup_failed' },
      })
    } catch {
      // The underlying store may itself be unavailable; do not mask the source error.
    }
    throw error
  }

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
  clearManualContinuationTicketsForTest()
}
