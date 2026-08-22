import { randomUUID } from 'node:crypto'
import type { ProferPermissionMode, SDKMessage } from '@profer/shared'
import { appendGraphEvent, loadHarnessGraphSnapshot } from '../project-graph-service'
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
}): PiHarnessRunScope | undefined {
  if (options.userMessage.trim() === '/compact') return undefined

  const before = loadPiHarnessSnapshot(options.sessionId)
  const existingGoal = latestRunnableGoal(before.goals)
  let graphSnapshot = loadHarnessGraphSnapshot(options.sessionId, existingGoal?.activeTaskId)
  const decision = decideGoalIntake({
    userMessage: options.userMessage,
    graph: graphSnapshot.graph,
    previousFocusTaskId: existingGoal?.activeTaskId,
  })
  if (decision.kind === 'manual_compact') return undefined

  let rootTaskId: string | undefined
  if (!existingGoal && decision.kind === 'minimal_root' && decision.rootTask) {
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
  appendPiHarnessEvent(options.sessionId, {
    version: 1,
    eventId: randomUUID(),
    timestamp: Date.now(),
    sessionId: options.sessionId,
    goalId,
    type: 'task_focus_changed',
    payload: { activeTaskId: selectedTaskId, reason: graphSnapshot.focusReason },
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
}
