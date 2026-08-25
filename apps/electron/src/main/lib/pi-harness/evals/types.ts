import type { GraphEvent } from '@profer/project-core'
import type { PiHarnessEvent } from '../types'

export interface PiHarnessEvalExpected {
  goalIntakeKind?: string
  focusTaskId?: string
  focusKind?: string
  assuranceByTask?: Record<string, string>
  telemetry?: Record<string, number>
}

/** JSON-serializable, model-free replay case. */
export interface PiHarnessEvalFixture {
  name: string
  sessionId: string
  /** Original user message used only for deterministic goal-intake classification. */
  userMessage: string
  /** Simulates a caller-established user goal conflict; never inferred by the eval runner. */
  goalConflict?: boolean
  graphEvents: GraphEvent[]
  harnessEvents: PiHarnessEvent[]
  expected: PiHarnessEvalExpected
}

export interface PiHarnessEvalResult {
  fixture: string
  passed: boolean
  failures: string[]
  actual: {
    goalIntakeKind: string
    focusTaskId?: string
    focusKind: string
    assuranceByTask: Record<string, string>
    telemetry: Record<string, number>
  }
}
