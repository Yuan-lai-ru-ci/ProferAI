import { getTaskVerificationContext, type TaskNode } from '@profer/project-core'
import type { AssuranceState, ToolFact, VerificationState } from './types'

export interface VerificationDecision {
  taskId: string
  state: AssuranceState
  reason: string
  evidenceFactIds: string[]
}

function factPath(fact: ToolFact): string | undefined {
  return typeof fact.subject.path === 'string' ? fact.subject.path : undefined
}

function category(fact: ToolFact): string | undefined {
  return typeof fact.subject.category === 'string' ? fact.subject.category : undefined
}

function criterionCategory(criterion: string): 'test' | 'typecheck' | 'build' | 'readback' | undefined {
  if (/\b(?:test|vitest|jest|bun test|npm test)\b/i.test(criterion)) return 'test'
  if (/\b(?:typecheck|tsc)\b/i.test(criterion)) return 'typecheck'
  if (/\bbuild\b/i.test(criterion)) return 'build'
  if (/\b(?:readback|read back|读回)\b/i.test(criterion)) return 'readback'
  return undefined
}

function latest<T>(items: T[], at: (item: T) => number): T | undefined {
  return [...items].sort((a, b) => at(b) - at(a))[0]
}

/**
 * Evaluates only finite, deterministic evidence. General task prose and model
 * claims never become verification evidence.
 */
export function evaluateVerification(options: {
  task: TaskNode
  facts: readonly ToolFact[]
  previous?: VerificationState
}): VerificationDecision {
  const { task, previous } = options
  if (previous?.state === 'waived') {
    return { taskId: task.id, state: 'waived', reason: previous.reason, evidenceFactIds: [...previous.evidenceFactIds] }
  }
  const contract = getTaskVerificationContext(task)
  if (!contract.required) return { taskId: task.id, state: 'not_required', reason: '任务未声明可确定验证契约', evidenceFactIds: [] }

  const facts = options.facts.filter((fact) => fact.taskId === task.id).sort((a, b) => a.timestamp - b.timestamp)
  const latestMutation = latest(facts.filter((fact) => fact.kind === 'file_mutation' && fact.outcome === 'success'), (fact) => fact.timestamp)
  const afterLatestMutation = (fact: ToolFact): boolean => !latestMutation || fact.timestamp >= latestMutation.timestamp

  const unsupported = contract.explicitCriteria.filter((criterion) => !criterionCategory(criterion))
  if (unsupported.length > 0) {
    return { taskId: task.id, state: 'pending', reason: '存在无法确定性匹配的 @verify 契约', evidenceFactIds: [] }
  }

  const verificationFacts = facts.filter((fact) => fact.kind === 'verification_command' && afterLatestMutation(fact))
  const lastVerification = latest(verificationFacts, (fact) => fact.timestamp)
  if (lastVerification?.outcome === 'failure') {
    return { taskId: task.id, state: 'failed', reason: '最近一次相关验证命令失败', evidenceFactIds: [lastVerification.id] }
  }

  const evidence: string[] = []
  for (const artifact of contract.artifacts) {
    const readback = latest(
      facts.filter((fact) => fact.kind === 'file_read' && fact.outcome === 'success' && factPath(fact) === artifact && afterLatestMutation(fact)),
      (fact) => fact.timestamp,
    )
    if (!readback) {
      return { taskId: task.id, state: 'pending', reason: `缺少产物读回证据: ${artifact}`, evidenceFactIds: evidence }
    }
    evidence.push(readback.id)
  }

  for (const criterion of contract.explicitCriteria) {
    const expected = criterionCategory(criterion)
    const matched = latest(
      verificationFacts.filter((fact) => fact.outcome === 'success' && category(fact) === expected),
      (fact) => fact.timestamp,
    )
    if (!matched) {
      return { taskId: task.id, state: 'pending', reason: `缺少验证证据: ${criterion}`, evidenceFactIds: evidence }
    }
    evidence.push(matched.id)
  }

  return { taskId: task.id, state: 'verified', reason: '工具事实满足已声明验证契约', evidenceFactIds: [...new Set(evidence)] }
}
