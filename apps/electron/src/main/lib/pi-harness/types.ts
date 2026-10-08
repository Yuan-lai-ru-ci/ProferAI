/** Internal, append-only execution-control events for Pi Host Harness. */

export const PI_HARNESS_EVENT_VERSION = 1 as const

export type PiHarnessGoalState = 'active' | 'paused' | 'settled' | 'cancelled'
export type PiHarnessTurnState =
  | 'starting'
  | 'running'
  | 'compacting'
  | 'retrying'
  | 'settled'
  | 'interrupted'
  | 'failed'
export type AssuranceState = 'not_required' | 'pending' | 'verified' | 'failed' | 'waived'

/** First-release policy is observational only: it must never create a follow-up model turn. */
export interface PiHarnessPolicySnapshot {
  governorMode: 'shadow'
  permissionMode: 'auto' | 'plan' | 'bypassPermissions'
  maxFocusChars: number
}

export interface PiTurnUsage {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  retries: number
  compactions: number
  durationMs: number
}

export interface PiHarnessGoal {
  id: string
  sessionId: string
  rootTaskId?: string
  activeTaskId?: string
  state: PiHarnessGoalState
  createdAt: number
  updatedAt: number
  policy: PiHarnessPolicySnapshot
}

export interface PiHarnessTurn {
  id: string
  goalId: string
  activeTaskId?: string
  state: PiHarnessTurnState
  startedAt: number
  endedAt?: number
  endReason?: string
  usage?: PiTurnUsage
}

export interface ToolFact {
  id: string
  goalId: string
  turnId: string
  taskId?: string
  kind: string
  timestamp: number
  toolName: string
  outcome: 'success' | 'failure' | 'unknown'
  subject: Record<string, unknown>
  summary: string
  fingerprint: string
}

export interface VerificationState {
  taskId: string
  state: AssuranceState
  reason: string
  evidenceFactIds: string[]
  updatedAt: number
}

interface PiHarnessEventBase {
  version: typeof PI_HARNESS_EVENT_VERSION
  eventId: string
  timestamp: number
  sessionId: string
  goalId: string
}

export type PiHarnessEvent =
  | (PiHarnessEventBase & {
      type: 'goal_created'
      payload: { rootTaskId?: string; activeTaskId?: string; policy: PiHarnessPolicySnapshot }
    })
  | (PiHarnessEventBase & {
      /** 兼容旧账本；新运行的焦点随 turn_started 写入。 */
      type: 'task_focus_changed'
      turnId?: string
      payload: { activeTaskId?: string; reason: string }
    })
  | (PiHarnessEventBase & {
      type: 'turn_started'
      turnId: string
      payload: { activeTaskId?: string }
    })
  | (PiHarnessEventBase & {
      type: 'turn_state_changed'
      turnId: string
      payload: { state: PiHarnessTurnState; endReason?: string; usage?: Partial<PiTurnUsage> }
    })
  | (PiHarnessEventBase & {
      type: 'tool_fact_recorded'
      turnId: string
      payload: { fact: ToolFact }
    })
  | (PiHarnessEventBase & {
      type: 'verification_state_changed'
      taskId: string
      payload: { state: AssuranceState; reason: string; evidenceFactIds: string[] }
    })
  | (PiHarnessEventBase & {
      type: 'governor_candidate_recorded'
      taskId?: string
      payload: { action: string; reason: string; blockedReason?: string; estimatedPromptChars: number; fingerprint: string }
    })
  | (PiHarnessEventBase & {
      /** Records a user click only; it never grants autonomous execution. */
      type: 'manual_candidate_continued'
      taskId: string
      payload: { candidateFingerprint: string }
    })
  | (PiHarnessEventBase & {
      type: 'goal_paused'
      payload: { reason: string }
    })
  | (PiHarnessEventBase & {
      /** 兼容旧账本的 fork 边界；shadow 不创建此事件。 */
      type: 'goal_settled'
      payload: { reason: string }
    })

export interface PiHarnessDiagnostic {
  line?: number
  code: 'invalid_json' | 'invalid_event' | 'unsupported_version' | 'duplicate_event'
  message: string
}

export interface GovernorCandidateRecord {
  eventId: string
  goalId: string
  taskId?: string
  timestamp: number
  action: string
  reason: string
  blockedReason?: string
  estimatedPromptChars: number
  fingerprint: string
}

export interface PiHarnessSnapshot {
  sessionId: string
  goals: Record<string, PiHarnessGoal>
  turns: Record<string, PiHarnessTurn>
  facts: Record<string, ToolFact>
  verificationByTask: Record<string, VerificationState>
  /** Persisted shadow candidate fingerprints prevent repeating the same no-change loop. */
  governorCandidateFingerprints: string[]
  /** Candidate fingerprints explicitly chosen by a user; never treated as autonomy. */
  manuallyContinuedCandidateFingerprints: string[]
  /** Sanitized later by the main process before renderer IPC projection. */
  governorCandidates: GovernorCandidateRecord[]
  goalPauseReasons: Record<string, string>
  diagnostics: PiHarnessDiagnostic[]
}

export function createEmptyPiHarnessSnapshot(sessionId: string): PiHarnessSnapshot {
  return {
    sessionId,
    goals: {},
    turns: {},
    facts: {},
    verificationByTask: {},
    governorCandidateFingerprints: [],
    manuallyContinuedCandidateFingerprints: [],
    governorCandidates: [],
    goalPauseReasons: {},
    diagnostics: [],
  }
}
