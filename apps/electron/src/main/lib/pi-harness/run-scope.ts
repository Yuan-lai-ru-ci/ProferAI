import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@profer/shared'
import { loadHarnessGraphSnapshot } from '../project-graph-service'
import { appendPiHarnessEvent, loadPiHarnessSnapshot } from './pi-harness-store'
import { createToolFact, type ToolFactInput } from './tool-facts'
import { reconcileFocusedTask, shouldPersistVerificationDecision } from './reconciler'
import { decideShadowGovernorCandidate } from './governor'
import type { PiHarnessEvent, PiTurnUsage } from './types'
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

function usageFromResult(message: SDKMessage, previous: PiTurnUsage): PiTurnUsage {
  if (message.type !== 'result') return previous
  const usage = (message as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
  return {
    ...previous,
    inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : previous.inputTokens,
    outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : previous.outputTokens,
  }
}

type ScopeEvent<Event = PiHarnessEvent> = Event extends PiHarnessEvent
  ? Omit<Event, 'version' | 'eventId' | 'timestamp' | 'sessionId' | 'goalId'>
  : never

export function createPiHarnessRunScope(options: {
  sessionId: string
  goalId: string
  turnId: string
  activeTaskId?: string
  prompt: string
  factFingerprints: Set<string>
}): PiHarnessRunScope {
  const { factFingerprints, ...context } = options
  const append = (event: ScopeEvent): void => appendPiHarnessEvent(options.sessionId, {
    ...event,
    version: 1,
    eventId: randomUUID(),
    timestamp: Date.now(),
    sessionId: options.sessionId,
    goalId: options.goalId,
  })
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
    append({
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
      append({
        taskId: decision.taskId,
        type: 'verification_state_changed',
        payload: { state: decision.state, reason: decision.reason, evidenceFactIds: decision.evidenceFactIds },
      })
    }

    const goal = snapshot.goals[options.goalId]
    const assurance = decision ? { ...decision, updatedAt: Date.now() } : previous
    if (!goal) return
    const candidate = decideShadowGovernorCandidate({
      graph,
      goal,
      assurance,
      facts: Object.values(snapshot.facts),
      existingFingerprints: new Set(snapshot.governorCandidateFingerprints),
    })
    if (!candidate) return
    append({
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
    ...context,
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
      if (settled || paused) return
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
      if (factFingerprints.has(fact.fingerprint)) return
      append({
        turnId: options.turnId,
        type: 'tool_fact_recorded',
        payload: { fact },
      })
      factFingerprints.add(fact.fingerprint)
    },
    pause(reason) {
      if (paused || settled) return
      paused = true
      appendState('interrupted', reason)
      append({
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
      // 单轮结束不代表项目完成；目标保留给用户后续继续，不自动发起下一轮。
    },
  }
}
