import { buildGraphFromEvents, selectHarnessFocus } from '@profer/project-core'
import { replayPiHarnessEvents } from '../pi-harness-reducer'
import { decideGoalIntake } from '../goal-controller'
import { reconcileFocusedTask } from '../reconciler'
import { collectPiHarnessTelemetry } from '../telemetry'
import type { PiHarnessEvalFixture, PiHarnessEvalResult } from './types'

function numericTelemetry(telemetry: ReturnType<typeof collectPiHarnessTelemetry>): Record<string, number> {
  return {
    modelCalls: telemetry.usage.modelCalls,
    inputTokens: telemetry.usage.inputTokens,
    outputTokens: telemetry.usage.outputTokens,
    retries: telemetry.usage.retries,
    compactions: telemetry.usage.compactions,
    candidateCount: telemetry.candidates.total,
    falseVerified: telemetry.verification.falseVerified,
    duplicateNoChangeFailedVerificationCandidates: telemetry.safety.duplicateNoChangeFailedVerificationCandidates,
    blockedNoChangeFailedVerificationLoops: telemetry.safety.blockedNoChangeFailedVerificationLoops,
    pauses: telemetry.safety.pauses,
    turnsStartedAfterPause: telemetry.safety.turnsStartedAfterPause,
    taskTransitions: telemetry.autonomy.taskTransitions,
  }
}

/**
 * Replays graph + sidecar JSON fixture entirely in memory. It exercises focus,
 * evidence/reconcile, and post-hoc telemetry but cannot call a model, queue a
 * prompt, mutate a session file, or produce an autonomy transition.
 */
export function evaluatePiHarnessFixture(fixture: PiHarnessEvalFixture): PiHarnessEvalResult {
  const graph = buildGraphFromEvents(fixture.graphEvents)
  const snapshot = replayPiHarnessEvents(fixture.sessionId, fixture.harnessEvents)
  const goal = Object.values(snapshot.goals)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]
  const intake = decideGoalIntake({
    userMessage: fixture.userMessage,
    graph,
    previousFocusTaskId: goal?.activeTaskId,
    goalConflict: fixture.goalConflict,
  })
  const focus = selectHarnessFocus(graph, goal?.activeTaskId)
  const assuranceByTask: Record<string, string> = {}
  for (const task of Object.values(graph.nodes)) {
    const decision = reconcileFocusedTask({
      graph,
      taskId: task.id,
      facts: Object.values(snapshot.facts),
      previous: snapshot.verificationByTask[task.id],
    })
    if (decision) assuranceByTask[task.id] = decision.state
  }
  const telemetry = numericTelemetry(collectPiHarnessTelemetry({ snapshot, graph, events: fixture.harnessEvents }))
  const actual = {
    goalIntakeKind: intake.kind,
    ...(focus.task ? { focusTaskId: focus.task.id } : {}),
    focusKind: focus.kind,
    assuranceByTask,
    telemetry,
  }
  const failures: string[] = []
  if (fixture.expected.goalIntakeKind !== undefined && actual.goalIntakeKind !== fixture.expected.goalIntakeKind) {
    failures.push(`goalIntakeKind: expected ${fixture.expected.goalIntakeKind}, got ${actual.goalIntakeKind}`)
  }
  if (fixture.expected.focusTaskId !== undefined && actual.focusTaskId !== fixture.expected.focusTaskId) {
    failures.push(`focusTaskId: expected ${fixture.expected.focusTaskId}, got ${actual.focusTaskId ?? 'undefined'}`)
  }
  if (fixture.expected.focusKind !== undefined && actual.focusKind !== fixture.expected.focusKind) {
    failures.push(`focusKind: expected ${fixture.expected.focusKind}, got ${actual.focusKind}`)
  }
  for (const [taskId, state] of Object.entries(fixture.expected.assuranceByTask ?? {})) {
    if (actual.assuranceByTask[taskId] !== state) {
      failures.push(`assurance ${taskId}: expected ${state}, got ${actual.assuranceByTask[taskId] ?? 'undefined'}`)
    }
  }
  for (const [metric, expected] of Object.entries(fixture.expected.telemetry ?? {})) {
    if (actual.telemetry[metric] !== expected) {
      failures.push(`telemetry ${metric}: expected ${expected}, got ${actual.telemetry[metric] ?? 'undefined'}`)
    }
  }
  return { fixture: fixture.name, passed: failures.length === 0, failures, actual }
}
