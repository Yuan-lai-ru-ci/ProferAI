import { getTaskVerificationContext, type TaskGraph } from '@profer/project-core'
import { evaluateVerification } from './verification-evaluator'
import type {
  AssuranceState,
  GovernorCandidateRecord,
  PiHarnessEvent,
  PiHarnessGoal,
  PiHarnessSnapshot,
  PiHarnessTurn,
  PiTurnUsage,
  ToolFact,
} from './types'

export const PI_HARNESS_TELEMETRY_VERSION = 1 as const

type CountBy<T extends string> = Record<T, number>
type CandidateBlockedReason = 'shadow_mode' | 'permission_mode' | 'repeat_failed_verification' | 'other'

export interface PiHarnessGoalTelemetry {
  state: PiHarnessGoal['state']
  turnCount: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  retries: number
  compactions: number
  durationMs: number
  estimatedCostUsd?: number
  taskTransitions: number
  repairAttempts: number
  equivalentVerificationRuns: number
  candidateCount: number
  paused: boolean
}

/**
 * Local-only diagnostic summary. It intentionally excludes prompts, tool input,
 * command/output bodies, paths, fact subjects, and renderer-facing data.
 */
export interface PiHarnessTelemetry {
  version: typeof PI_HARNESS_TELEMETRY_VERSION
  sessionId: string
  goals: CountBy<PiHarnessGoal['state']> & { total: number }
  turns: CountBy<PiHarnessTurn['state']> & { total: number }
  usage: PiTurnUsage & { estimatedCostUsd: number }
  autonomy: {
    taskTransitions: number
    repairAttempts: number
    equivalentVerificationRuns: number
  }
  candidates: {
    total: number
    requiredVerification: number
    readyTask: number
    byBlockedReason: CountBy<CandidateBlockedReason>
  }
  verification: CountBy<AssuranceState> & {
    tracked: number
    requiredTasks: number
    coverageRatio: number
    falseVerified: number
  }
  safety: {
    /** Persisted candidate violating the loop breaker; target is always zero. */
    duplicateNoChangeFailedVerificationCandidates: number
    /** Facts that the Governor should (and currently does) block from rerunning. */
    blockedNoChangeFailedVerificationLoops: number
    pauses: number
    /** A new turn after pause is surfaced for manual audit, never treated as autonomous success. */
    turnsStartedAfterPause: number
    sidecarDiagnostics: number
  }
  byGoal: Record<string, PiHarnessGoalTelemetry>
}

function usageOf(turn: PiHarnessTurn): PiTurnUsage {
  return turn.usage ?? {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    retries: 0,
    compactions: 0,
    durationMs: 0,
  }
}

function emptyStateCounts<T extends string>(states: readonly T[]): CountBy<T> {
  return Object.fromEntries(states.map((state) => [state, 0])) as CountBy<T>
}

function sumRecord(record: Record<string, number>): number {
  return Object.values(record).reduce((total, value) => total + value, 0)
}

function candidateBlockedReason(candidate: GovernorCandidateRecord): CandidateBlockedReason {
  if (candidate.blockedReason === 'shadow_mode') return 'shadow_mode'
  if (candidate.blockedReason === 'permission_mode') return 'permission_mode'
  if (candidate.blockedReason === 'repeat_failed_verification') return 'repeat_failed_verification'
  return 'other'
}

function hasNoChangeFailedValidation(candidate: GovernorCandidateRecord, facts: readonly ToolFact[]): boolean {
  if (candidate.action !== 'required_verification' || !candidate.taskId) return false
  const taskFacts = facts.filter((fact) => fact.taskId === candidate.taskId && fact.timestamp <= candidate.timestamp)
  const failure = [...taskFacts]
    .filter((fact) => fact.kind === 'verification_command' && fact.outcome === 'failure')
    .sort((a, b) => b.timestamp - a.timestamp)[0]
  if (!failure) return false
  return !taskFacts.some((fact) => (
    fact.kind === 'file_mutation'
    && fact.outcome === 'success'
    && fact.timestamp > failure.timestamp
  ))
}

function latestPauseTimestamp(events: readonly PiHarnessEvent[], goalId: string): number | undefined {
  return [...events]
    .filter((event) => event.goalId === goalId && event.type === 'goal_paused')
    .sort((a, b) => b.timestamp - a.timestamp)[0]
    ?.timestamp
}

/**
 * Replays only persisted facts into an exportable, deterministic diagnostic.
 * It does not schedule, mutate a ledger, send telemetry remotely, or invoke a
 * model. Supplying source events enables boundary diagnostics that a reduced
 * snapshot intentionally does not retain.
 */
export function collectPiHarnessTelemetry(options: {
  snapshot: PiHarnessSnapshot
  graph: TaskGraph
  events?: readonly PiHarnessEvent[]
}): PiHarnessTelemetry {
  const { snapshot, graph } = options
  const events = options.events ?? []
  const goalStates = ['active', 'paused', 'settled', 'cancelled'] as const
  const turnStates = ['starting', 'running', 'compacting', 'retrying', 'settled', 'interrupted', 'failed'] as const
  const assuranceStates = ['not_required', 'pending', 'verified', 'failed', 'waived'] as const
  const goals = { total: 0, ...emptyStateCounts(goalStates) }
  const turns = { total: 0, ...emptyStateCounts(turnStates) }
  const verification = { tracked: 0, requiredTasks: 0, coverageRatio: 1, falseVerified: 0, ...emptyStateCounts(assuranceStates) }
  const usage: PiTurnUsage & { estimatedCostUsd: number } = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    retries: 0,
    compactions: 0,
    durationMs: 0,
    estimatedCostUsd: 0,
  }
  const byGoal: Record<string, PiHarnessGoalTelemetry> = {}

  for (const goal of Object.values(snapshot.goals)) {
    goals.total += 1
    goals[goal.state] += 1
    const turnsForGoal = Object.values(snapshot.turns).filter((turn) => turn.goalId === goal.id)
    const candidatesForGoal = snapshot.governorCandidates.filter((candidate) => candidate.goalId === goal.id)
    const autonomy = goal.autonomyUsage
    const cost = autonomy.estimatedCostUsd
    byGoal[goal.id] = {
      state: goal.state,
      turnCount: turnsForGoal.length,
      modelCalls: turnsForGoal.reduce((total, turn) => total + usageOf(turn).modelCalls, 0),
      inputTokens: turnsForGoal.reduce((total, turn) => total + usageOf(turn).inputTokens, 0),
      outputTokens: turnsForGoal.reduce((total, turn) => total + usageOf(turn).outputTokens, 0),
      retries: turnsForGoal.reduce((total, turn) => total + usageOf(turn).retries, 0),
      compactions: turnsForGoal.reduce((total, turn) => total + usageOf(turn).compactions, 0),
      durationMs: turnsForGoal.reduce((total, turn) => total + usageOf(turn).durationMs, 0),
      ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
      taskTransitions: autonomy.taskTransitions,
      repairAttempts: sumRecord(autonomy.repairAttemptsByTask),
      equivalentVerificationRuns: sumRecord(autonomy.equivalentVerificationRuns),
      candidateCount: candidatesForGoal.length,
      paused: goal.state === 'paused',
    }
  }

  for (const turn of Object.values(snapshot.turns)) {
    turns.total += 1
    turns[turn.state] += 1
    const turnUsage = usageOf(turn)
    usage.modelCalls += turnUsage.modelCalls
    usage.inputTokens += turnUsage.inputTokens
    usage.outputTokens += turnUsage.outputTokens
    usage.retries += turnUsage.retries
    usage.compactions += turnUsage.compactions
    usage.durationMs += turnUsage.durationMs
  }

  const autonomy = Object.values(snapshot.goals).reduce((result, goal) => {
    result.taskTransitions += goal.autonomyUsage.taskTransitions
    result.repairAttempts += sumRecord(goal.autonomyUsage.repairAttemptsByTask)
    result.equivalentVerificationRuns += sumRecord(goal.autonomyUsage.equivalentVerificationRuns)
    usage.estimatedCostUsd += goal.autonomyUsage.estimatedCostUsd ?? 0
    return result
  }, { taskTransitions: 0, repairAttempts: 0, equivalentVerificationRuns: 0 })

  for (const stored of Object.values(snapshot.verificationByTask)) {
    verification.tracked += 1
    verification[stored.state] += 1
  }
  for (const task of Object.values(graph.nodes)) {
    if (!getTaskVerificationContext(task).required) continue
    verification.requiredTasks += 1
    const stored = snapshot.verificationByTask[task.id]
    if (stored?.state === 'verified') {
      const recomputed = evaluateVerification({ task, facts: Object.values(snapshot.facts), previous: stored })
      if (recomputed.state !== 'verified') verification.falseVerified += 1
    }
  }
  verification.coverageRatio = verification.requiredTasks === 0
    ? 1
    : verification.verified / verification.requiredTasks

  const candidateReasons = emptyStateCounts(['shadow_mode', 'permission_mode', 'repeat_failed_verification', 'other'] as const)
  let requiredVerification = 0
  let readyTask = 0
  for (const candidate of snapshot.governorCandidates) {
    if (candidate.action === 'required_verification') requiredVerification += 1
    if (candidate.action === 'ready_task') readyTask += 1
    candidateReasons[candidateBlockedReason(candidate)] += 1
  }

  const blockedNoChangeFailedVerificationLoops = Object.values(snapshot.verificationByTask)
    .filter((assurance) => assurance.state === 'failed')
    .filter((assurance) => {
      const facts = Object.values(snapshot.facts).filter((fact) => fact.taskId === assurance.taskId)
      const failure = [...facts]
        .filter((fact) => fact.kind === 'verification_command' && fact.outcome === 'failure')
        .sort((a, b) => b.timestamp - a.timestamp)[0]
      return Boolean(failure && !facts.some((fact) => (
        fact.kind === 'file_mutation'
        && fact.outcome === 'success'
        && fact.timestamp > failure.timestamp
      )))
    }).length
  const pauses = events.filter((event) => event.type === 'goal_paused').length
  const turnsStartedAfterPause = events.filter((event) => {
    if (event.type !== 'turn_started') return false
    const pauseTimestamp = latestPauseTimestamp(events, event.goalId)
    return pauseTimestamp !== undefined && event.timestamp > pauseTimestamp
  }).length

  return {
    version: PI_HARNESS_TELEMETRY_VERSION,
    sessionId: snapshot.sessionId,
    goals,
    turns,
    usage,
    autonomy,
    candidates: {
      total: snapshot.governorCandidates.length,
      requiredVerification,
      readyTask,
      byBlockedReason: candidateReasons,
    },
    verification,
    safety: {
      duplicateNoChangeFailedVerificationCandidates: snapshot.governorCandidates.filter((candidate) => (
        hasNoChangeFailedValidation(candidate, Object.values(snapshot.facts))
      )).length,
      blockedNoChangeFailedVerificationLoops,
      pauses,
      turnsStartedAfterPause,
      sidecarDiagnostics: snapshot.diagnostics.length,
    },
    byGoal,
  }
}

/** Stable JSON for local export or snapshot-based regression diffs. */
export function serializePiHarnessTelemetry(telemetry: PiHarnessTelemetry): string {
  return `${JSON.stringify(telemetry, null, 2)}\n`
}
