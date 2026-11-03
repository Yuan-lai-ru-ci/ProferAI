/**
 * Agent 规划 Todo 操作层。
 *
 * Claude/Pi 共享这里的本地 workspace 路由、并发校验和事件广播。
 */

import type {
  CalendarEvent,
  CalendarEventListQuery,
  CreateCalendarEventInput,
  CreateTodoInput,
  Todo,
  TodoListQuery,
  UpdateCalendarEventInput,
  UpdateTodoInput,
} from '@profer/shared'
import {
  createCalendarEvent,
  createTodo,
  deleteCalendarEvent,
  getCalendarEvent,
  getTodo,
  listCalendarEvents,
  listTodos,
  touchTodoSession,
  updateCalendarEvent,
  updateTodo,
} from './planning-manager'
import { broadcastPlanningAgentOperation, broadcastPlanningChanged } from './planning-events'

export interface PlanningAgentToolContext {
  sessionId: string
  workspaceId?: string
}

function assertTodoInContext(todo: Todo | undefined, ctx: PlanningAgentToolContext): Todo {
  if (!todo) throw new Error('Todo 不存在')
  if (!ctx.workspaceId && todo.workspaceId) throw new Error('Todo 不属于当前 Agent 项目')
  if (ctx.workspaceId && todo.workspaceId !== ctx.workspaceId) throw new Error('Todo 不属于当前工作区')
  return todo
}

function assertCalendarEventInContext(event: CalendarEvent | undefined, ctx: PlanningAgentToolContext): CalendarEvent {
  if (!event) throw new Error('日程不存在')
  if (!ctx.workspaceId && event.workspaceId) throw new Error('日程不属于当前 Agent 项目')
  if (ctx.workspaceId && event.workspaceId !== ctx.workspaceId) throw new Error('日程不属于当前工作区')
  return event
}

function filterTodos(todos: Todo[], query: TodoListQuery): Todo[] {
  const filtered = todos.filter((todo) => {
    if (query.status && todo.status !== query.status) return false
    if (query.dueBefore !== undefined && (todo.dueAt === undefined || todo.dueAt > query.dueBefore)) return false
    return true
  })
  return query.limit === undefined ? filtered : filtered.slice(0, Math.min(query.limit, 500))
}

export async function listPlanningTodos(ctx: PlanningAgentToolContext, query: TodoListQuery = {}): Promise<Todo[]> {
  return filterTodos(listTodos({ ...query, workspaceId: ctx.workspaceId }), query)
}

export async function getPlanningTodo(ctx: PlanningAgentToolContext, id: string): Promise<Todo> {
  return assertTodoInContext(getTodo(id), ctx)
}

export async function createPlanningTodo(ctx: PlanningAgentToolContext, input: Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>): Promise<Todo> {
  const todo = createTodo({ ...input, ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}), sessionId: ctx.sessionId })
  broadcastPlanningChanged(['todos', 'reminders'])
  broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'todo', action: 'created', title: todo.title })
  return todo
}

export async function updatePlanningTodo(ctx: PlanningAgentToolContext, input: Omit<UpdateTodoInput, 'workspaceId'>): Promise<Todo> {
  await getPlanningTodo(ctx, input.id)
  if (input.expectedUpdatedAt === undefined) throw new Error('更新 Todo 前必须提供 expectedUpdatedAt；请先读取 Todo 的最新记录')
  // 更新不改绑工作区：workspaceId 属于归属信息，由用户显式改绑（IPC UPDATE_TODO），
  // Agent 在别的项目里按 id 更新时不能把 Todo 静默搬到当前项目。
  const updated = updateTodo({ ...input })
  if (!updated) throw new Error('Todo 不存在')
  touchTodoSession(updated.id, ctx.sessionId)
  broadcastPlanningChanged(['todos', 'reminders'])
  broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'todo', action: 'updated', title: updated.title })
  return updated
}

function filterCalendarEvents(events: CalendarEvent[], query: CalendarEventListQuery, workspaceId?: string): CalendarEvent[] {
  const filtered = events.filter((event) => {
    if (workspaceId && event.workspaceId !== workspaceId) return false
    if (query.from !== undefined && (event.endAt ?? event.startAt) < query.from) return false
    if (query.to !== undefined && event.startAt > query.to) return false
    return true
  })
  return query.limit === undefined ? filtered : filtered.slice(0, Math.min(query.limit, 500))
}

export async function listPlanningCalendarEvents(ctx: PlanningAgentToolContext, query: CalendarEventListQuery = {}): Promise<CalendarEvent[]> {
  return filterCalendarEvents(listCalendarEvents(query), query, ctx.workspaceId)
}

export async function getPlanningCalendarEvent(ctx: PlanningAgentToolContext, id: string): Promise<CalendarEvent> {
  return assertCalendarEventInContext(getCalendarEvent(id), ctx)
}

export async function createPlanningCalendarEvent(ctx: PlanningAgentToolContext, input: Omit<CreateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent> {
  const event = createCalendarEvent({ ...input, ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}) })
  broadcastPlanningChanged(['calendar_events', 'reminders'])
  broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'created', title: event.title })
  return event
}

export async function updatePlanningCalendarEvent(ctx: PlanningAgentToolContext, input: Omit<UpdateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent> {
  await getPlanningCalendarEvent(ctx, input.id)
  // 同 Todo：更新日程不改变归属项目。
  const updated = updateCalendarEvent({ ...input })
  if (!updated) throw new Error('日程不存在')
  broadcastPlanningChanged(['calendar_events', 'reminders'])
  broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'updated', title: updated.title })
  return updated
}

export async function deletePlanningCalendarEvent(ctx: PlanningAgentToolContext, id: string): Promise<boolean> {
  const event = await getPlanningCalendarEvent(ctx, id)
  if (!deleteCalendarEvent(id)) throw new Error('日程不存在')
  broadcastPlanningChanged(['calendar_events', 'reminders'])
  broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'deleted', title: event.title })
  return true
}
