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
import type { PlanningAgentOperation, PlanningChangeResource } from '@profer/shared'
import type { PlanningStore } from './planning-store'

export interface PlanningAgentToolContext {
  sessionId: string
  workspaceId?: string
}

export function createPlanningAgentOperations(
  store: PlanningStore,
  events: {
    broadcastPlanningChanged(resources: PlanningChangeResource[]): void
    broadcastPlanningAgentOperation(operation: PlanningAgentOperation): void
    beforeWrite?(ctx: PlanningAgentToolContext, toolName: string, input: Record<string, unknown>): void | Promise<void>
  },
) {
  const { createCalendarEvent, createTodo, deleteCalendarEvent, getCalendarEvent, getTodo,
    listCalendarEvents, listTodos, touchTodoSession, updateCalendarEvent, updateTodo } = store
  const { broadcastPlanningChanged, broadcastPlanningAgentOperation } = events
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

  async function listPlanningTodos(ctx: PlanningAgentToolContext, query: TodoListQuery = {}): Promise<Todo[]> {
    return filterTodos(listTodos({ ...query, limit: undefined, workspaceId: ctx.workspaceId ?? null }).filter(todo => todo.workspaceId === ctx.workspaceId), query)
  }

  async function getPlanningTodo(ctx: PlanningAgentToolContext, id: string): Promise<Todo> {
    return assertTodoInContext(getTodo(id), ctx)
  }

  async function createPlanningTodo(ctx: PlanningAgentToolContext, input: Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>): Promise<Todo> {
    await events.beforeWrite?.(ctx, 'mcp__planning__create_todo', input)
    const todo = createTodo({ ...input, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId })
    broadcastPlanningChanged(['todos', 'reminders'])
    broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'todo', action: 'created', title: todo.title })
    return todo
  }

  async function updatePlanningTodo(ctx: PlanningAgentToolContext, input: Omit<UpdateTodoInput, 'workspaceId'>): Promise<Todo> {
    await events.beforeWrite?.(ctx, 'mcp__planning__update_todo', input)
    await getPlanningTodo(ctx, input.id)
    if (input.expectedUpdatedAt === undefined) throw new Error('更新 Todo 前必须提供 expectedUpdatedAt；请先读取 Todo 的最新记录')
    // 更新不改绑工作区：workspaceId 属于归属信息，由用户显式改绑（IPC UPDATE_TODO），
    // Agent 在别的项目里按 id 更新时不能把 Todo 静默搬到当前项目。
    const updated = updateTodo({ ...input, workspaceId: ctx.workspaceId ?? null })
    if (!updated) throw new Error('Todo 不存在')
    touchTodoSession(updated.id, ctx.sessionId)
    broadcastPlanningChanged(['todos', 'reminders'])
    broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'todo', action: 'updated', title: updated.title })
    return updated
  }

  function filterCalendarEvents(events: CalendarEvent[], query: CalendarEventListQuery, workspaceId?: string): CalendarEvent[] {
    const filtered = events.filter((event) => {
      if (event.workspaceId !== workspaceId) return false
      if (query.from !== undefined && (event.endAt ?? event.startAt) < query.from) return false
      if (query.to !== undefined && event.startAt > query.to) return false
      return true
    })
    return query.limit === undefined ? filtered : filtered.slice(0, Math.min(query.limit, 500))
  }

  async function listPlanningCalendarEvents(ctx: PlanningAgentToolContext, query: CalendarEventListQuery = {}): Promise<CalendarEvent[]> {
    return filterCalendarEvents(listCalendarEvents({ ...query, limit: undefined }), query, ctx.workspaceId)
  }

  async function getPlanningCalendarEvent(ctx: PlanningAgentToolContext, id: string): Promise<CalendarEvent> {
    return assertCalendarEventInContext(getCalendarEvent(id), ctx)
  }

  async function createPlanningCalendarEvent(ctx: PlanningAgentToolContext, input: Omit<CreateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent> {
    await events.beforeWrite?.(ctx, 'mcp__planning__create_calendar_event', input)
    const event = createCalendarEvent({ ...input, workspaceId: ctx.workspaceId })
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'created', title: event.title })
    return event
  }

  async function updatePlanningCalendarEvent(ctx: PlanningAgentToolContext, input: Omit<UpdateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent> {
    await events.beforeWrite?.(ctx, 'mcp__planning__update_calendar_event', input)
    await getPlanningCalendarEvent(ctx, input.id)
    // 同 Todo：更新日程不改变归属项目。
    if (input.expectedUpdatedAt === undefined) throw new Error('更新日程前必须提供 expectedUpdatedAt；请先读取日程的最新记录')
    const updated = updateCalendarEvent({ ...input, workspaceId: ctx.workspaceId ?? null })
    if (!updated) throw new Error('日程不存在')
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'updated', title: updated.title })
    return updated
  }

  async function deletePlanningCalendarEvent(ctx: PlanningAgentToolContext, id: string): Promise<boolean> {
    await events.beforeWrite?.(ctx, 'mcp__planning__delete_calendar_event', { id })
    const event = await getPlanningCalendarEvent(ctx, id)
    if (!deleteCalendarEvent(id)) throw new Error('日程不存在')
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    broadcastPlanningAgentOperation({ sessionId: ctx.sessionId, target: 'calendar_event', action: 'deleted', title: event.title })
    return true
  }

  return { listPlanningTodos, getPlanningTodo, createPlanningTodo, updatePlanningTodo, listPlanningCalendarEvents, getPlanningCalendarEvent, createPlanningCalendarEvent, updatePlanningCalendarEvent, deletePlanningCalendarEvent }
}
