import { PLANNING_CONFLICT_ERROR, type StartTodoAgentInput } from '@profer/shared'
import type { CoreAgentRuntime } from './runtime'

const OPERATIONS = new Set([
  'startTodoAgent',
  'listTodos', 'getTodo', 'createTodo', 'updateTodo', 'deleteTodo',
  'listCalendarEvents', 'getCalendarEvent', 'createCalendarEvent', 'updateCalendarEvent', 'deleteCalendarEvent',
  'listPlanningGroups', 'createPlanningGroup', 'updatePlanningGroup', 'deletePlanningGroup',
  'listPlanningTags', 'createPlanningTag', 'updatePlanningTag', 'deletePlanningTag',
  'listActivePlanningReminders', 'acknowledgePlanningReminder', 'snoozePlanningReminder',
])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Planning input must be an object')
  return value as Record<string, unknown>
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Planning id is required')
}
function scope(value: unknown): void {
  if (value !== 'todo' && value !== 'calendar') throw new Error('Invalid Planning group scope')
}
function validateInput(input: Record<string, unknown>): void {
  for (const field of ['title', 'name', 'notes', 'color', 'sessionId', 'workspaceId', 'todoId', 'groupId'] as const) {
    const value = input[field]
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`Invalid Planning ${field}`)
  }
  for (const field of ['dueAt', 'startAt', 'endAt', 'from', 'to', 'dueBefore', 'expectedUpdatedAt'] as const) {
    const value = input[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new Error(`Invalid Planning ${field}`)
  }
  if (input.priority !== undefined && !['low', 'medium', 'high'].includes(String(input.priority))) throw new Error('Invalid Planning priority')
  if (input.status !== undefined && !['open', 'completed'].includes(String(input.status))) throw new Error('Invalid Planning status')
  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') throw new Error('Invalid Planning allDay')
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1)) throw new Error('Invalid Planning limit')
  if (input.tagIds !== undefined && (!Array.isArray(input.tagIds) || input.tagIds.some(value => typeof value !== 'string'))) throw new Error('Invalid Planning tagIds')
  if (input.reminders !== undefined && (!Array.isArray(input.reminders) || input.reminders.some(value => !value || typeof value !== 'object' || typeof value.triggerAt !== 'number' || !Number.isFinite(value.triggerAt) || value.triggerAt <= 0))) throw new Error('Invalid Planning reminders')
  if (typeof input.from === 'number' && typeof input.to === 'number' && input.from > input.to) throw new Error('Invalid Planning date range')
}

/** Fixed operation allowlist. Never expose database lifecycle or arbitrary method invocation. */
export function executeCorePlanningOperation(runtime: CoreAgentRuntime, body: Record<string, unknown>): unknown {
  if (typeof body.operation !== 'string' || !OPERATIONS.has(body.operation)) throw new Error('Unsupported Planning operation')
  const args = body.args === undefined ? [] : body.args
  if (!Array.isArray(args) || args.length > 2) throw new Error('Invalid Planning arguments')
  const operation = body.operation
  if (operation === 'startTodoAgent') {
    const input = object(args[0])
    id(input.todoId)
    id(input.workspaceId)
    id(input.channelId)
    if (input.modelId !== undefined) id(input.modelId)
    validateInput(input)
    if (typeof input.expectedUpdatedAt !== 'number' || !Number.isFinite(input.expectedUpdatedAt) || input.expectedUpdatedAt <= 0) throw new Error('Todo expectedUpdatedAt is required')
    if (!runtime.workspaces.list().some(workspace => workspace.id === input.workspaceId)) throw new Error('Planning workspace not found on this Core')
    const channel = runtime.channels.find(channel => channel.id === input.channelId)
    if (!channel || channel.enabled === false) throw new Error('Planning Agent channel not found on this Core')
    const todo = runtime.planning.getTodo(input.todoId)
    if (!todo) throw new Error('Todo not found')
    if (todo.updatedAt !== input.expectedUpdatedAt) throw new Error(PLANNING_CONFLICT_ERROR)
    const typed = input as unknown as StartTodoAgentInput
    const updated = todo.workspaceId === typed.workspaceId ? todo : runtime.planning.updateTodo({ id: todo.id, workspaceId: typed.workspaceId, expectedUpdatedAt: todo.updatedAt })!
    const session = runtime.sessions.create({ title: `处理：${todo.title}`, workspaceId: typed.workspaceId, channelId: typed.channelId, modelId: typed.modelId, runtime: 'pi' })
    return { todo: updated, session }
  }
  const noArguments = ['listPlanningTags', 'listActivePlanningReminders']
  if (noArguments.includes(operation)) {
    if (args.length) throw new Error('Planning operation takes no arguments')
  } else if (operation === 'listPlanningGroups' || operation === 'deletePlanningGroup') {
    scope(args[0])
    if (operation === 'deletePlanningGroup') id(args[1])
  } else if (operation.startsWith('get') || operation.startsWith('delete') || operation === 'acknowledgePlanningReminder' || operation === 'snoozePlanningReminder') {
    id(args[0])
    if (operation === 'snoozePlanningReminder' && (typeof args[1] !== 'number' || !Number.isFinite(args[1]) || args[1] <= 0)) throw new Error('Invalid Planning snooze duration')
  } else {
    const input = object(args[0] ?? (operation.startsWith('list') ? {} : undefined))
    validateInput(input)
    if (operation.startsWith('update')) id(input.id)
    if (operation.includes('PlanningGroup')) scope(input.scope)
    if (input.workspaceId !== undefined && input.workspaceId !== null && !runtime.workspaces.list().some(workspace => workspace.id === input.workspaceId)) throw new Error('Planning workspace not found on this Core')
    if (input.sessionId !== undefined && input.sessionId !== null && !runtime.sessions.getMeta(String(input.sessionId))) throw new Error('Planning session not found on this Core')
    if (input.sessionId && input.workspaceId && runtime.sessions.getMeta(String(input.sessionId))?.workspaceId !== input.workspaceId) throw new Error('Planning session belongs to another workspace')
  }
  const method = runtime.planning[operation as keyof typeof runtime.planning]
  // All arguments have been checked above; invocation stays behind the fixed protocol allowlist.
  return Reflect.apply(method, runtime.planning, args) ?? null
}
