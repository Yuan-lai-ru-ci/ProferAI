/**
 * Sanitized, renderer-safe Pi Host Harness views.
 *
 * These types deliberately exclude ToolFact subjects, command hashes, event IDs
 * and raw ledger diagnostics. The Electron main process owns that projection.
 */

export type PiHarnessAssuranceViewState = 'not_required' | 'pending' | 'verified' | 'failed' | 'waived'
export type PiHarnessExecutionViewState = 'starting' | 'running' | 'compacting' | 'retrying' | 'settled' | 'interrupted' | 'failed'
export type PiHarnessGoalViewState = 'active' | 'paused' | 'settled' | 'cancelled'

export interface PiHarnessTurnView {
  state: PiHarnessExecutionViewState
  endedAt?: number
  endReason?: string
  modelCalls?: number
  inputTokens?: number
  outputTokens?: number
  retries?: number
  compactions?: number
  durationMs?: number
}

export interface PiHarnessShadowCandidateView {
  action: 'required_verification' | 'ready_task'
  reason: string
  blockedReason?: string
}

export interface PiHarnessTaskView {
  taskId: string
  assurance?: {
    state: PiHarnessAssuranceViewState
    reason: string
    updatedAt: number
  }
  execution?: PiHarnessTurnView
  lastFactSummary?: string
  shadowCandidate?: PiHarnessShadowCandidateView
}

export interface PiHarnessSnapshotView {
  sessionId: string
  goal?: {
    state: PiHarnessGoalViewState
    activeTaskId?: string
    pauseReason?: string
  }
  tasks: Record<string, PiHarnessTaskView>
}
