import type { TaskGraph } from '@profer/project-core'
import { getReadyTasks } from '@profer/project-core'
import type { PiHarnessGoal, ToolFact, VerificationState } from './types'

export interface GovernorCandidate {
  taskId?: string
  action: 'required_verification' | 'ready_task'
  reason: string
  blockedReason: 'shadow_mode' | 'permission_mode' | 'repeat_failed_verification'
  estimatedPromptChars: number
  fingerprint: string
}

function latest<T extends { timestamp: number }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => b.timestamp - a.timestamp)[0]
}

/**
 * Decides whether to record a shadow candidate. It never imports Adapter,
 * queue, prompt chain, or autonomy budget writers, so it cannot start work.
 */
export function decideShadowGovernorCandidate(options: {
  graph: TaskGraph
  goal: PiHarnessGoal
  assurance?: VerificationState
  facts: readonly ToolFact[]
  existingFingerprints: ReadonlySet<string>
}): GovernorCandidate | undefined {
  if (options.goal.state !== 'active') return undefined
  const activeTaskId = options.goal.activeTaskId
  if (options.goal.policy.permissionMode !== 'bypassPermissions') {
    const fingerprint = `permission:${activeTaskId ?? 'graphless'}`
    if (options.existingFingerprints.has(fingerprint)) return undefined
    return { taskId: activeTaskId, action: 'required_verification', reason: '当前权限模式不允许自主候选', blockedReason: 'permission_mode', estimatedPromptChars: 0, fingerprint }
  }

  if (activeTaskId && (options.assurance?.state === 'pending' || options.assurance?.state === 'failed')) {
    const taskFacts = options.facts.filter((fact) => fact.taskId === activeTaskId)
    const lastFailure = latest(taskFacts.filter((fact) => fact.kind === 'verification_command' && fact.outcome === 'failure'))
    const mutationAfterFailure = lastFailure && taskFacts.some((fact) => fact.kind === 'file_mutation' && fact.outcome === 'success' && fact.timestamp > lastFailure.timestamp)
    if (lastFailure && !mutationAfterFailure) return undefined
    const fingerprint = `verify:${activeTaskId}:${options.assurance.state}:${lastFailure?.id ?? 'pending'}`
    if (options.existingFingerprints.has(fingerprint)) return undefined
    return {
      taskId: activeTaskId,
      action: 'required_verification',
      reason: options.assurance.reason,
      blockedReason: 'shadow_mode',
      estimatedPromptChars: 240,
      fingerprint,
    }
  }

  const next = getReadyTasks(options.graph)
    .filter((task) => task.id !== activeTaskId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
  if (!next) return undefined
  const fingerprint = `ready:${next.id}`
  if (options.existingFingerprints.has(fingerprint)) return undefined
  return {
    taskId: next.id,
    action: 'ready_task',
    reason: `下游任务已就绪: ${next.subject}`,
    blockedReason: 'shadow_mode',
    estimatedPromptChars: 240,
    fingerprint,
  }
}
