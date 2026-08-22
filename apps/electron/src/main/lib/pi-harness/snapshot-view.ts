import type { PiHarnessSnapshotView } from '@profer/shared'
import type { PiHarnessGoal, PiHarnessSnapshot, PiHarnessTurn } from './types'

function latest<T>(items: readonly T[], getTimestamp: (item: T) => number): T | undefined {
  return [...items].sort((a, b) => getTimestamp(b) - getTimestamp(a))[0]
}

function latestGoal(goals: Record<string, PiHarnessGoal>): PiHarnessGoal | undefined {
  return latest(Object.values(goals), (goal) => goal.updatedAt)
}

function toTurnView(turn: PiHarnessTurn): PiHarnessSnapshotView['tasks'][string]['execution'] {
  return {
    state: turn.state,
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(turn.endReason ? { endReason: turn.endReason } : {}),
    ...(turn.usage ? {
      modelCalls: turn.usage.modelCalls,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      retries: turn.usage.retries,
      compactions: turn.usage.compactions,
      durationMs: turn.usage.durationMs,
    } : {}),
  }
}

/**
 * Projects an internal Harness snapshot into the small, renderer-safe view.
 * ToolFact subject, hashes, fingerprints, event IDs and diagnostics never cross
 * this boundary.
 */
export function toPiHarnessSnapshotView(snapshot: PiHarnessSnapshot): PiHarnessSnapshotView {
  const tasks: PiHarnessSnapshotView['tasks'] = {}
  const goal = latestGoal(snapshot.goals)

  for (const assurance of Object.values(snapshot.verificationByTask)) {
    tasks[assurance.taskId] = {
      taskId: assurance.taskId,
      assurance: { state: assurance.state, reason: assurance.reason, updatedAt: assurance.updatedAt },
    }
  }

  const newestTurnByTask = new Map<string, PiHarnessTurn>()
  for (const turn of Object.values(snapshot.turns)) {
    if (!turn.activeTaskId) continue
    const prior = newestTurnByTask.get(turn.activeTaskId)
    const timestamp = turn.endedAt ?? turn.startedAt
    if (!prior || timestamp >= (prior.endedAt ?? prior.startedAt)) newestTurnByTask.set(turn.activeTaskId, turn)
  }
  for (const [taskId, turn] of newestTurnByTask) {
    const prior = tasks[taskId]
    tasks[taskId] = { taskId, ...prior, execution: toTurnView(turn) }
  }

  // summary is created from tool name/path/category only; raw content and hashes stay internal.
  for (const fact of [...Object.values(snapshot.facts)].sort((a, b) => b.timestamp - a.timestamp)) {
    if (!fact.taskId || tasks[fact.taskId]?.lastFactSummary) continue
    const existing = tasks[fact.taskId]
    tasks[fact.taskId] = { taskId: fact.taskId, ...existing, lastFactSummary: fact.summary }
  }

  for (const candidate of [...snapshot.governorCandidates].sort((a, b) => a.timestamp - b.timestamp)) {
    const taskId = candidate.taskId ?? goal?.activeTaskId
    if (!taskId) continue
    const existing = tasks[taskId]
    tasks[taskId] = {
      taskId,
      ...existing,
      shadowCandidate: {
        action: candidate.action === 'ready_task' ? 'ready_task' : 'required_verification',
        reason: candidate.reason,
        blockedReason: candidate.blockedReason,
      },
    }
  }

  return {
    sessionId: snapshot.sessionId,
    ...(goal ? {
      goal: {
        state: goal.state,
        ...(goal.activeTaskId ? { activeTaskId: goal.activeTaskId } : {}),
        ...(snapshot.goalPauseReasons[goal.id] ? { pauseReason: snapshot.goalPauseReasons[goal.id] } : {}),
      },
    } : {}),
    tasks,
  }
}
