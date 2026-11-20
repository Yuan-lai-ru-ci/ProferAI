/** Host-neutral Pi Planning tool definitions; hosts supply ownership-aware operations. */
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { filterDisabledTools } from '@profer/shared'
import type { CalendarEvent, CalendarEventListQuery, CreateCalendarEventInput, CreateTodoInput, Todo, TodoListQuery, UpdateCalendarEventInput, UpdateTodoInput } from '@profer/shared'
type PiSdk = Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
type Context = { sessionId: string; workspaceId?: string }
export interface PlanningToolOperations {
  listPlanningTodos(ctx: Context, query?: TodoListQuery): Promise<Todo[]>
  getPlanningTodo(ctx: Context, id: string): Promise<Todo>
  createPlanningTodo(ctx: Context, input: Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>): Promise<Todo>
  updatePlanningTodo(ctx: Context, input: Omit<UpdateTodoInput, 'workspaceId'>): Promise<Todo>
  listPlanningCalendarEvents(ctx: Context, query?: CalendarEventListQuery): Promise<CalendarEvent[]>
  getPlanningCalendarEvent(ctx: Context, id: string): Promise<CalendarEvent>
  createPlanningCalendarEvent(ctx: Context, input: Omit<CreateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent>
  updatePlanningCalendarEvent(ctx: Context, input: Omit<UpdateCalendarEventInput, 'workspaceId'>): Promise<CalendarEvent>
  deletePlanningCalendarEvent(ctx: Context, id: string): Promise<boolean>
}
function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
}
export async function loadPiPlanningToolDefinitions(
  ctx: { sessionId: string; workspaceId?: string; disabledTools?: string[] },
  operations: PlanningToolOperations,
): Promise<ToolDefinition[]> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  return buildPiPlanningToolDefinitions(sdk, ctx, operations)
}

export function buildPiPlanningToolDefinitions(
  sdk: PiSdk,
  ctx: { sessionId: string; workspaceId?: string; disabledTools?: string[] },
  operations: PlanningToolOperations,
): ToolDefinition[] {
  const { createPlanningCalendarEvent, createPlanningTodo, deletePlanningCalendarEvent, getPlanningCalendarEvent, getPlanningTodo, listPlanningCalendarEvents, listPlanningTodos, updatePlanningCalendarEvent, updatePlanningTodo } = operations
  const tools = [
    sdk.defineTool({
      name: 'mcp__planning__list_todos',
      label: '列出规划 Todo',
      description: '列出当前 Agent 项目中的规划 Todo。规划 Todo 与任务图不同，适合记录用户待办和后续事项。',
      parameters: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('completed')])),
        dueBefore: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      async execute(_toolCallId, params) {
        try {
          return jsonToolResult({ todos: await listPlanningTodos({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as TodoListQuery) })
        } catch (error) {
          return jsonToolResult({ error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__get_todo',
      label: '读取规划 Todo',
      description: '读取当前 Agent 项目中某个规划 Todo 的原始最新记录。更新前必须先读取，以获得 expectedUpdatedAt。',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      async execute(_toolCallId, params) {
        try {
          const { id } = params as { id: string }
          return jsonToolResult({ todo: await getPlanningTodo({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, id.trim()) })
        } catch (error) {
          return jsonToolResult({ error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__create_todo',
      label: '创建规划 Todo',
      description: '在当前 Agent 项目的规划中心创建 Todo。仅在用户目标确实需要记录规划待办时使用。',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }),
        notes: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
        dueAt: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        groupId: Type.Optional(Type.String({ minLength: 1 })),
        tagIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        reminders: Type.Optional(Type.Array(Type.Object({ triggerAt: Type.Number({ exclusiveMinimum: 0 }) }))),
        assigneeId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_toolCallId, params) {
        try {
          return jsonToolResult({ todo: await createPlanningTodo({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>) })
        } catch (error) {
          return jsonToolResult({ error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__update_todo',
      label: '更新规划 Todo',
      description: '更新当前 Agent 项目的规划 Todo。必须先读取最新 Todo，并把其 updatedAt 作为 expectedUpdatedAt；冲突时重新读取。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        expectedUpdatedAt: Type.Number({ exclusiveMinimum: 0 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        notes: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
        dueAt: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])),
        groupId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        tagIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('completed')])),
        assigneeId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      }),
      async execute(_toolCallId, params) {
        try {
          return jsonToolResult({ todo: await updatePlanningTodo({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as Omit<UpdateTodoInput, 'workspaceId'>) })
        } catch (error) {
          return jsonToolResult({ error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__list_calendar_events',
      label: '列出本地日程',
      description: '列出当前 Profer 工作区的本地日程；用户未明确要求外部日历时，日程默认指这里。',
      parameters: Type.Object({ from: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), to: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      async execute(_toolCallId, params) {
        try { return jsonToolResult({ events: await listPlanningCalendarEvents({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as CalendarEventListQuery) }) } catch (error) { return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__get_calendar_event',
      label: '读取本地日程',
      description: '读取当前 Profer 工作区本地日程的最新记录；更新前必须先读取。',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      async execute(_toolCallId, params) {
        try { return jsonToolResult({ event: await getPlanningCalendarEvent({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, (params as { id: string }).id) }) } catch (error) { return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__create_calendar_event',
      label: '创建本地日程',
      description: '在当前 Profer 工作区创建本地日程。除非用户明确要求 Google、Outlook 或其他外部日历，否则不要询问日历平台。',
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }), notes: Type.Optional(Type.String()), startAt: Type.Number({ exclusiveMinimum: 0 }), endAt: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), allDay: Type.Optional(Type.Boolean()), groupId: Type.Optional(Type.String({ minLength: 1 })), tagIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), reminders: Type.Optional(Type.Array(Type.Object({ triggerAt: Type.Number({ exclusiveMinimum: 0 }) }))), todoId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_toolCallId, params) {
        try { return jsonToolResult({ event: await createPlanningCalendarEvent({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as Omit<CreateCalendarEventInput, 'workspaceId'>) }) } catch (error) { return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__update_calendar_event',
      label: '更新本地日程',
      description: '更新当前 Profer 工作区本地日程；必须先读取最新日程并传入 expectedUpdatedAt。',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), expectedUpdatedAt: Type.Number({ exclusiveMinimum: 0 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), notes: Type.Optional(Type.String()), startAt: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), endAt: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])), allDay: Type.Optional(Type.Boolean()), groupId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])), tagIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), todoId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])), }),
      async execute(_toolCallId, params) {
        try { return jsonToolResult({ event: await updatePlanningCalendarEvent({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, params as Omit<UpdateCalendarEventInput, 'workspaceId'>) }) } catch (error) { return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
    sdk.defineTool({
      name: 'mcp__planning__delete_calendar_event',
      label: '删除本地日程',
      description: '仅在用户明确要求时删除当前 Profer 工作区本地日程。',
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      async execute(_toolCallId, params) {
        try { return jsonToolResult({ deleted: await deletePlanningCalendarEvent({ sessionId: ctx.sessionId, workspaceId: ctx.workspaceId }, (params as { id: string }).id) }) } catch (error) { return jsonToolResult({ error: error instanceof Error ? error.message : String(error) }) }
      },
    }),
  ]
  return filterDisabledTools(tools, ctx.disabledTools) as unknown as ToolDefinition[]
}
