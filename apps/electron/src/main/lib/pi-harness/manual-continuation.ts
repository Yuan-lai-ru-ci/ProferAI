import { randomUUID } from 'node:crypto'
import { getReadyTasks, type TaskNode } from '@profer/project-core'
import { loadHarnessGraphSnapshot } from '../project-graph-service'
import { loadPiHarnessSnapshot } from './pi-harness-store'

export interface ManualCandidateContinuationTicket {
  id: string
  sessionId: string
  goalId: string
  taskId: string
  candidateFingerprint: string
  userMessage: string
}

/**
 * Tickets exist only in main-process memory between a user click and the normal
 * Agent send path. They are not prompt text, IPC input, sidecar state, or an
 * autonomous scheduling queue.
 */
const manualCandidateContinuationTickets = new Map<string, ManualCandidateContinuationTicket>()

function latestManualCandidate(snapshot: ReturnType<typeof loadPiHarnessSnapshot>, sessionId: string, taskId: string): ManualCandidateContinuationTicket | undefined {
  const graph = loadHarnessGraphSnapshot(sessionId).graph
  const task = graph.nodes[taskId]
  if (!task || !getReadyTasks(graph).some((candidate) => candidate.id === taskId)) return undefined
  const candidate = [...snapshot.governorCandidates]
    .filter((item) => item.taskId === taskId
      && item.action === 'ready_task'
      && item.blockedReason === 'shadow_mode'
      && !snapshot.manuallyContinuedCandidateFingerprints.includes(item.fingerprint)
      && snapshot.goals[item.goalId]?.state === 'active'
      && snapshot.goals[item.goalId]?.policy.governorMode === 'shadow')
    .sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId))[0]
  if (!candidate) return undefined
  return {
    id: randomUUID(),
    sessionId,
    goalId: candidate.goalId,
    taskId,
    candidateFingerprint: candidate.fingerprint,
    userMessage: buildManualCandidateContinuationMessage(task),
  }
}

function clipped(value: string, maxChars: number): string {
  const safe = value
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|prelay)_[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...safe]
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/** The visible user instruction is deliberately finite and task-only. */
function buildManualCandidateContinuationMessage(task: TaskNode): string {
  const description = clipped(task.description, 600)
  return [
    `继续 Project Graph 中已就绪的任务：${clipped(task.subject, 180)}`,
    description ? `任务说明：${description}` : '',
    '这是用户明确选择的后续任务。仅聚焦该任务；如需改变方向，请先向用户说明。',
  ].filter(Boolean).join('\n')
}

/**
 * Revalidates a renderer-nominated task against Graph + sidecar and reserves a
 * one-shot main-process ticket. This has no model or queue side effect.
 */
export function prepareManualContinuationTicket(sessionId: string, taskId: string): { ticketId: string; userMessage: string } {
  if ([...manualCandidateContinuationTickets.values()].some((ticket) => ticket.sessionId === sessionId && ticket.taskId === taskId)) {
    throw new Error('该候选任务正在启动，请勿重复继续')
  }
  const candidate = latestManualCandidate(loadPiHarnessSnapshot(sessionId), sessionId, taskId)
  if (!candidate) throw new Error('该任务不是可继续的就绪候选，或候选已失效')
  manualCandidateContinuationTickets.set(candidate.id, candidate)
  return { ticketId: candidate.id, userMessage: candidate.userMessage }
}

/** Releases an unconsumed ticket after the normal send path rejects or ends. */
export function releaseManualPiHarnessCandidateContinuation(ticketId: string): void {
  manualCandidateContinuationTickets.delete(ticketId)
}

export function takeManualCandidateContinuation(ticketId: string | undefined, sessionId: string): ManualCandidateContinuationTicket | undefined {
  if (!ticketId) return undefined
  const ticket = manualCandidateContinuationTickets.get(ticketId)
  if (!ticket || ticket.sessionId !== sessionId) return undefined
  manualCandidateContinuationTickets.delete(ticketId)
  // The interval from explicit user click to Pi start has no active Agent run;
  // nevertheless re-read deterministic state before consuming the candidate.
  const current = latestManualCandidate(loadPiHarnessSnapshot(sessionId), sessionId, ticket.taskId)
  if (!current || current.goalId !== ticket.goalId || current.candidateFingerprint !== ticket.candidateFingerprint) return undefined
  return ticket
}

export function clearManualContinuationTicketsForTest(): void {
  manualCandidateContinuationTickets.clear()
}
