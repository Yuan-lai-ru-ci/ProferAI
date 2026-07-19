import type { GraphEvent, TaskStatus } from '@profer/project-core'
import {
  isStructuredTaskGraphTool,
  parseAbandon,
  parseDependsOn,
} from '@profer/project-core'

export interface TaskToolInvocation {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  result?: unknown
}

export interface TaskGraphEventConversion {
  events: GraphEvent[]
  nextCurrentTaskId?: string
}

export interface TaskGraphAutoLinkContext {
  currentTaskId: string | null
  lastCompletedTaskId: string | null
}

const TASK_STATUSES = new Set<TaskStatus>([
  'pending', 'in_progress', 'completed', 'failed', 'cancelled',
])

function textFromResult(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (!Array.isArray(result)) return undefined
  const text = result
    .map((block) => (
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    ))
    .join('')
  return text || undefined
}

function parseCreatedTask(result: unknown): { id: string; subject?: string } | null {
  const text = textFromResult(result)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { task?: { id?: unknown; subject?: unknown } }
    if (typeof parsed.task?.id === 'string' || typeof parsed.task?.id === 'number') {
      return {
        id: String(parsed.task.id),
        ...(typeof parsed.task.subject === 'string' && { subject: parsed.task.subject }),
      }
    }
  } catch { /* legacy text fallback below */ }
  const match = text.match(/Task\s*#(\d+)/i)
  return match?.[1] ? { id: match[1] } : null
}

function taskIdFromInput(input: Record<string, unknown>): string | undefined {
  const value = input.taskId ?? input.task_id ?? input.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function stringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  if (!Array.isArray(input[key])) return undefined
  return input[key].map(String).filter(Boolean)
}

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' && input[key].length > 0 ? input[key] as string : undefined
}

/** Converts native Claude Task tool results into durable Graph events. */
export function nativeTaskToolToGraphEvents(
  invocation: TaskToolInvocation,
  sessionId: string,
  timestamp: number,
  autoLinkContext: TaskGraphAutoLinkContext,
): TaskGraphEventConversion {
  if (invocation.toolName === 'TaskCreate') {
    const created = parseCreatedTask(invocation.result)
    const taskId = created?.id ?? invocation.toolUseId
    const subject = stringValue(invocation.input, 'subject') ?? created?.subject ?? '未命名任务'
    const description = stringValue(invocation.input, 'description') ?? ''
    const explicitDependencies = stringArray(invocation.input, 'dependsOn')
    const parsedDependencies = parseDependsOn(description)
    const explicitForkFrom = stringValue(invocation.input, 'forkFrom')
    const hasExplicitRelationship = explicitDependencies !== undefined || parsedDependencies.length > 0 || explicitForkFrom !== undefined
    const forkFrom = explicitForkFrom ?? (hasExplicitRelationship ? undefined : autoLinkContext.currentTaskId ?? undefined)
    const dependsOn = explicitDependencies
      ?? (parsedDependencies.length > 0
        ? parsedDependencies
        : (!forkFrom && autoLinkContext.lastCompletedTaskId ? [autoLinkContext.lastCompletedTaskId] : []))

    return {
      nextCurrentTaskId: taskId,
      events: [
        { type: 'task_created', taskId, timestamp, payload: { subject, description, dependsOn, ...(forkFrom && { forkFrom }) } },
        { type: 'task_session_linked', taskId, timestamp, payload: { sessionId } },
      ],
    }
  }

  if (invocation.toolName !== 'TaskUpdate') return { events: [] }
  const taskId = taskIdFromInput(invocation.input)
  if (!taskId) return { events: [] }

  const events: GraphEvent[] = []
  const status = invocation.input.status
  if (status === 'deleted') {
    events.push({ type: 'task_deleted', taskId, timestamp, payload: { source: 'agent' } })
  } else if (typeof status === 'string' && TASK_STATUSES.has(status as TaskStatus)) {
    events.push({ type: 'task_status_changed', taskId, timestamp, payload: { newStatus: status as TaskStatus } })
  }

  const subject = stringValue(invocation.input, 'subject')
  const description = stringValue(invocation.input, 'description')
  const dependsOn = stringArray(invocation.input, 'dependsOn')
  if (subject !== undefined || description !== undefined || dependsOn !== undefined) {
    events.push({
      type: 'task_updated', taskId, timestamp,
      payload: { ...(subject !== undefined && { subject }), ...(description !== undefined && { description }), ...(dependsOn !== undefined && { dependsOn }) },
    })
  }

  const abandonReason = (description ? parseAbandon(description) : null) ?? stringValue(invocation.input, 'abandonReason')
  if (abandonReason) {
    events.push({ type: 'task_abandon_annotated', taskId, timestamp, payload: { reason: abandonReason, confidence: 1, evidenceTurns: [], source: 'agent' } })
  }
  return { events, nextCurrentTaskId: taskId }
}

/** Structured MCP handlers persist their own events; only use them to track task association. */
export function structuredTaskToolCurrentTaskId(invocation: TaskToolInvocation): string | undefined {
  if (!isStructuredTaskGraphTool(invocation.toolName)) return undefined
  if (invocation.toolName.endsWith('proma_task_create')) return parseCreatedTask(invocation.result)?.id
  return taskIdFromInput(invocation.input)
}

/** Adds the same durable auto-link semantics to structured MCP task creation. */
export function structuredTaskAutoLinkEvent(
  invocation: TaskToolInvocation,
  timestamp: number,
  context: TaskGraphAutoLinkContext,
): GraphEvent | undefined {
  if (!invocation.toolName.endsWith('proma_task_create')) return undefined
  const taskId = structuredTaskToolCurrentTaskId(invocation)
  if (!taskId) return undefined
  const description = stringValue(invocation.input, 'description') ?? ''
  const explicitDependencies = stringArray(invocation.input, 'dependsOn')
  const hasExplicitRelationship =
    explicitDependencies !== undefined ||
    parseDependsOn(description).length > 0 ||
    stringValue(invocation.input, 'forkFrom') !== undefined
  if (hasExplicitRelationship) return undefined
  if (context.currentTaskId && context.currentTaskId !== taskId) {
    return { type: 'task_updated', taskId, timestamp, payload: { forkFrom: context.currentTaskId } }
  }
  if (context.lastCompletedTaskId && context.lastCompletedTaskId !== taskId) {
    return { type: 'task_updated', taskId, timestamp, payload: { dependsOn: [context.lastCompletedTaskId] } }
  }
  return undefined
}

/** Converts a delegation into a visible, navigable child node in the parent graph. */
export function delegationToGraphEvents(
  parentTaskId: string,
  delegation: { delegationId: string; childSessionId: string },
  invocation: TaskToolInvocation,
  timestamp: number,
): GraphEvent[] {
  const taskId = `delegation:${delegation.delegationId}`
  const subject = stringValue(invocation.input, 'title') ?? '委派子任务'
  const description = stringValue(invocation.input, 'task') ?? ''
  return [
    { type: 'task_created', taskId, timestamp, payload: { subject, description, dependsOn: [], forkFrom: parentTaskId } },
    { type: 'task_session_linked', taskId, timestamp, payload: { sessionId: delegation.delegationId, childSessionId: delegation.childSessionId } },
    { type: 'task_status_changed', taskId, timestamp, payload: { newStatus: 'in_progress' } },
  ]
}

/** Supports both the SDK-native name and the namespaced MCP tool name. */
export function isDelegateAgentTool(toolName: string): boolean {
  return toolName === 'delegate_agent' || toolName.endsWith('__delegate_agent')
}

export function delegationLinkFromResult(result: unknown): { delegationId: string; childSessionId: string } | null {
  const text = textFromResult(result)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as {
      delegation?: { delegationId?: unknown; childSessionId?: unknown }
      delegationId?: unknown
      childSessionId?: unknown
    }
    const delegationId = parsed.delegation?.delegationId ?? parsed.delegationId
    const childSessionId = parsed.delegation?.childSessionId ?? parsed.childSessionId
    return typeof delegationId === 'string' && typeof childSessionId === 'string'
      ? { delegationId, childSessionId }
      : null
  } catch {
    return null
  }
}
