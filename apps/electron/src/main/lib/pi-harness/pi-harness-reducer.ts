import {
  createEmptyPiHarnessSnapshot,
  type PiGoalAutonomyUsage,
  type PiHarnessDiagnostic,
  type PiHarnessEvent,
  type PiHarnessSnapshot,
  type PiTurnUsage,
} from './types'

const EMPTY_AUTONOMY_USAGE: PiGoalAutonomyUsage = {
  taskTransitions: 0,
  repairAttemptsByTask: {},
  equivalentVerificationRuns: {},
}

function mergeUsage(previous: PiTurnUsage | undefined, next: Partial<PiTurnUsage> | undefined): PiTurnUsage | undefined {
  if (!next) return previous
  return {
    modelCalls: next.modelCalls ?? previous?.modelCalls ?? 0,
    inputTokens: next.inputTokens ?? previous?.inputTokens ?? 0,
    outputTokens: next.outputTokens ?? previous?.outputTokens ?? 0,
    retries: next.retries ?? previous?.retries ?? 0,
    compactions: next.compactions ?? previous?.compactions ?? 0,
    durationMs: next.durationMs ?? previous?.durationMs ?? 0,
  }
}

export function replayPiHarnessEvents(
  sessionId: string,
  events: readonly PiHarnessEvent[],
  diagnostics: PiHarnessDiagnostic[] = [],
): PiHarnessSnapshot {
  const snapshot = createEmptyPiHarnessSnapshot(sessionId)
  snapshot.diagnostics.push(...diagnostics)
  const seenEventIds = new Set<string>()

  for (const event of events) {
    if (event.sessionId !== sessionId) {
      snapshot.diagnostics.push({ code: 'invalid_event', message: `忽略属于其他会话的 Harness 事件: ${event.eventId}` })
      continue
    }
    if (seenEventIds.has(event.eventId)) {
      snapshot.diagnostics.push({ code: 'duplicate_event', message: `忽略重复 Harness 事件: ${event.eventId}` })
      continue
    }
    seenEventIds.add(event.eventId)

    switch (event.type) {
      case 'goal_created':
        snapshot.goals[event.goalId] = {
          id: event.goalId,
          sessionId,
          rootTaskId: event.payload.rootTaskId,
          activeTaskId: event.payload.activeTaskId,
          state: 'active',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          policy: event.payload.policy,
          autonomyUsage: { ...EMPTY_AUTONOMY_USAGE, repairAttemptsByTask: {}, equivalentVerificationRuns: {} },
        }
        break
      case 'task_focus_changed': {
        const goal = snapshot.goals[event.goalId]
        if (goal) {
          goal.activeTaskId = event.payload.activeTaskId
          goal.updatedAt = event.timestamp
        }
        break
      }
      case 'turn_started': {
        const goal = snapshot.goals[event.goalId]
        if (goal) goal.updatedAt = event.timestamp
        snapshot.turns[event.turnId] = {
          id: event.turnId,
          goalId: event.goalId,
          activeTaskId: event.payload.activeTaskId,
          state: 'starting',
          startedAt: event.timestamp,
        }
        break
      }
      case 'turn_state_changed': {
        const turn = snapshot.turns[event.turnId]
        if (turn) {
          turn.state = event.payload.state
          turn.endReason = event.payload.endReason ?? turn.endReason
          turn.usage = mergeUsage(turn.usage, event.payload.usage)
          if (event.payload.state === 'settled' || event.payload.state === 'interrupted' || event.payload.state === 'failed') {
            turn.endedAt = event.timestamp
          }
        }
        break
      }
      case 'tool_fact_recorded':
        snapshot.facts[event.payload.fact.id] = event.payload.fact
        break
      case 'verification_state_changed':
        snapshot.verificationByTask[event.taskId] = {
          taskId: event.taskId,
          state: event.payload.state,
          reason: event.payload.reason,
          evidenceFactIds: [...event.payload.evidenceFactIds],
          updatedAt: event.timestamp,
        }
        break
      case 'autonomy_budget_consumed': {
        const goal = snapshot.goals[event.goalId]
        if (!goal) break
        const usage = goal.autonomyUsage
        if (event.payload.kind === 'task_transition') usage.taskTransitions += 1
        if (event.payload.kind === 'repair_attempt' && event.taskId) {
          usage.repairAttemptsByTask[event.taskId] = (usage.repairAttemptsByTask[event.taskId] ?? 0) + 1
        }
        if (event.payload.kind === 'verification_run' && event.taskId) {
          usage.equivalentVerificationRuns[event.taskId] = (usage.equivalentVerificationRuns[event.taskId] ?? 0) + 1
        }
        if (event.payload.estimatedCostUsd !== undefined) {
          usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + event.payload.estimatedCostUsd
        }
        break
      }
      case 'goal_paused': {
        const goal = snapshot.goals[event.goalId]
        if (goal) {
          goal.state = 'paused'
          goal.updatedAt = event.timestamp
          snapshot.goalPauseReasons[event.goalId] = event.payload.reason
        }
        break
      }
      case 'goal_settled': {
        const goal = snapshot.goals[event.goalId]
        if (goal) {
          goal.state = 'settled'
          goal.updatedAt = event.timestamp
        }
        break
      }
      case 'governor_candidate_recorded':
        if (!snapshot.governorCandidateFingerprints.includes(event.payload.fingerprint)) {
          snapshot.governorCandidateFingerprints.push(event.payload.fingerprint)
          snapshot.governorCandidates.push({
            eventId: event.eventId,
            goalId: event.goalId,
            ...(event.taskId ? { taskId: event.taskId } : {}),
            timestamp: event.timestamp,
            action: event.payload.action,
            reason: event.payload.reason,
            blockedReason: event.payload.blockedReason,
            estimatedPromptChars: event.payload.estimatedPromptChars,
            fingerprint: event.payload.fingerprint,
          })
        }
        break
      case 'manual_candidate_continued':
        if (!snapshot.manuallyContinuedCandidateFingerprints.includes(event.payload.candidateFingerprint)) {
          snapshot.manuallyContinuedCandidateFingerprints.push(event.payload.candidateFingerprint)
        }
        break
    }
  }

  return snapshot
}
