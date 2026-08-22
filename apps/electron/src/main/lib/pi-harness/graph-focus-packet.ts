import {
  getHarnessBlockedTasks,
  getReadyTasks,
  getTaskVerificationContext,
  selectHarnessFocus,
  type TaskGraph,
} from '@profer/project-core'
import type { AssuranceState, PiHarnessGoal, VerificationState } from './types'

export const GRAPH_FOCUS_MAX_CHARS = 1_200
export const GRAPH_FOCUS_MAX_TOKENS = 300

export interface GraphFocusPacketInput {
  graph: TaskGraph
  goal?: Pick<PiHarnessGoal, 'id' | 'activeTaskId' | 'policy'>
  previousFocusTaskId?: string
  verificationByTask?: Record<string, VerificationState>
  lastFactSummary?: string
  resumeSummary?: string
  maxChars?: number
  maxTokens?: number
}

function estimateTokens(text: string): number {
  let tokens = 0
  let asciiRun = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiRun += 1
      continue
    }
    tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
    tokens += 1
  }
  return tokens + Math.ceil(asciiRun / 4)
}

function redact(value: string): string {
  return value
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|prelay)_[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(value: string, maxChars: number): string {
  const chars = [...redact(value)]
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/** Ensures both character and deterministic token-estimate limits. */
function fitPacket(lines: string[], maxChars: number, maxTokens: number): string {
  const accepted: string[] = []
  for (const line of lines) {
    const candidate = [...accepted, line].join('\n')
    if ([...candidate].length <= maxChars && estimateTokens(candidate) <= maxTokens) {
      accepted.push(line)
      continue
    }
    const suffix = '\ntruncated: true'
    const budget = Math.max(0, maxChars - [...accepted.join('\n')].length - [...suffix].length)
    const clipped = clip(line, budget)
    const final = [...accepted, clipped, 'truncated: true'].join('\n')
    if ([...final].length <= maxChars && estimateTokens(final) <= maxTokens) accepted.push(clipped, 'truncated: true')
    break
  }
  return accepted.join('\n')
}

function assuranceLabel(state: AssuranceState | undefined): string {
  return state ?? 'not_required'
}

/**
 * Builds a bounded, redacted packet for a single Pi user-level turn. It is a
 * transient prompt addition, never a replacement for user text or system prompt.
 */
export function buildGraphFocusPacket(input: GraphFocusPacketInput): string {
  const maxChars = Math.min(input.maxChars ?? GRAPH_FOCUS_MAX_CHARS, GRAPH_FOCUS_MAX_CHARS)
  const maxTokens = Math.min(input.maxTokens ?? GRAPH_FOCUS_MAX_TOKENS, GRAPH_FOCUS_MAX_TOKENS)
  const focus = selectHarnessFocus(input.graph, input.goal?.activeTaskId ?? input.previousFocusTaskId)
  const task = focus.task
  const lines = ['<graph_focus>']

  if (input.goal) {
    lines.push(`goal: ${clip(input.goal.id, 80)} | policy: ${input.goal.policy.permissionMode} | mode: ${input.goal.policy.governorMode}`)
  } else {
    lines.push('goal: graphless | mode: shadow')
  }
  if (!task) {
    lines.push(`focus: ${focus.kind} | ${focus.reason}`)
    lines.push('</graph_focus>')
    return fitPacket(lines, maxChars, maxTokens)
  }

  lines.push(`active: ${clip(task.id, 80)} — ${clip(task.subject, 180)}`)
  const verification = getTaskVerificationContext(task)
  if (verification.explicitCriteria.length > 0) {
    lines.push(`acceptance: ${clip(verification.explicitCriteria.slice(0, 2).join(' | '), 220)}`)
  } else if (verification.artifacts.length > 0) {
    lines.push(`artifact: ${clip(verification.artifacts.slice(0, 2).join(', '), 180)}`)
  }
  const assurance = input.verificationByTask?.[task.id]
  lines.push(`assurance: ${assuranceLabel(assurance?.state)}${assurance ? ` | ${clip(assurance.reason, 130)}` : ''}`)

  const ready = getReadyTasks(input.graph)
    .filter((node) => node.id !== task.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, 2)
  if (ready.length > 0) lines.push(`ready: ${ready.map((node) => `${clip(node.id, 32)} ${clip(node.subject, 60)}`).join(' | ')}`)

  const blocked = getHarnessBlockedTasks(input.graph).slice(0, 2)
  if (blocked.length > 0) {
    lines.push(`blocked: ${blocked.map(({ task: blockedTask, unmetDependencies }) => `${clip(blockedTask.id, 32)} ← ${unmetDependencies.slice(0, 2).map((item) => `${clip(item.id, 24)}:${item.status}`).join(',')}`).join(' | ')}`)
  }
  if (input.lastFactSummary) lines.push(`last_fact: ${clip(input.lastFactSummary, 180)}`)
  if (input.resumeSummary) lines.push(`resume: ${clip(input.resumeSummary, 180)}`)
  lines.push('</graph_focus>')
  return fitPacket(lines, maxChars, maxTokens)
}

export function estimateGraphFocusPacketTokens(packet: string): number {
  return estimateTokens(packet)
}
