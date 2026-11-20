import { randomUUID } from 'node:crypto'
import type { ProferPermissionMode } from '@profer/shared'
import { buildGraphFocusPacket } from './graph-focus-packet'
import { decideGoalIntake } from './goal-controller'
import type { PiHarnessGoal, PiHarnessPolicySnapshot } from './types'
import { createPiHarnessRunScope, type PiHarnessRunScope } from './run-scope'
import type { PiHarnessScopePorts } from './run-scope'
import type { GraphEvent, TaskGraph } from '../../../project-core/src/index'

export interface PiHarnessRuntimePorts extends PiHarnessScopePorts {
  appendGraphEvent(sessionId: string, event: GraphEvent): void
  loadHarnessGraphSnapshot(sessionId: string, previousFocusTaskId?: string): { graph: TaskGraph; focusTaskId?: string }
}

export function createPiHarnessRuntime(ports: PiHarnessRuntimePorts) {
const { appendGraphEvent, loadHarnessGraphSnapshot, appendPiHarnessEvent, loadPiHarnessSnapshot } = ports
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
function startPiHarnessRun(options: {
  sessionId: string
  userMessage: string
  prompt: string
  permissionMode: ProferPermissionMode
}): PiHarnessRunScope | undefined {
  if (options.userMessage.trim() === '/compact') return undefined

  if (activeScopes.has(options.sessionId)) throw new Error('会话已有活跃 Harness scope')
  const before = loadPiHarnessSnapshot(options.sessionId)
  const existingGoal = latestRunnableGoal(before.goals)
  let graphSnapshot = loadHarnessGraphSnapshot(options.sessionId, existingGoal?.activeTaskId)
  const decision = decideGoalIntake({
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

  const selectedTaskId = graphSnapshot.focusTaskId
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
  }, ports)

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

function pauseActivePiHarnessRun(sessionId: string, reason = 'user_stop'): void {
  const scope = activeScopes.get(sessionId)
  if (!scope) return
  try {
    scope.pause(reason)
  } finally {
    if (activeScopes.get(sessionId) === scope) activeScopes.delete(sessionId)
  }
}

function settlePiHarnessRun(sessionId: string, outcome: 'completed' | 'failed'): void {
  const scope = activeScopes.get(sessionId)
  if (!scope) return
  try {
    scope.settle(outcome)
  } finally {
    if (activeScopes.get(sessionId) === scope) activeScopes.delete(sessionId)
  }
}

return { startPiHarnessRun, pauseActivePiHarnessRun, settlePiHarnessRun,
  getActiveScope: (sessionId: string) => activeScopes.get(sessionId) }
}
