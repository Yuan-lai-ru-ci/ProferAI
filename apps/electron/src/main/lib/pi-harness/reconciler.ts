import type { TaskGraph } from '@profer/project-core'
import { evaluateVerification, type VerificationDecision } from './verification-evaluator'
import type { ToolFact, VerificationState } from './types'

/** Reconciles one focused task; it never mutates Project Graph task status. */
export function reconcileFocusedTask(options: {
  graph: TaskGraph
  taskId?: string
  facts: readonly ToolFact[]
  previous?: VerificationState
}): VerificationDecision | undefined {
  if (!options.taskId) return undefined
  const task = options.graph.nodes[options.taskId]
  if (!task) return undefined
  return evaluateVerification({ task, facts: options.facts, previous: options.previous })
}

export function shouldPersistVerificationDecision(
  decision: VerificationDecision,
  previous?: VerificationState,
): boolean {
  if (!previous) return true
  if (previous.state !== decision.state || previous.reason !== decision.reason) return true
  if (previous.evidenceFactIds.length !== decision.evidenceFactIds.length) return true
  return previous.evidenceFactIds.some((id, index) => decision.evidenceFactIds[index] !== id)
}
