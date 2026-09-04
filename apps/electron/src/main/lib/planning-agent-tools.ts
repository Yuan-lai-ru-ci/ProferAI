/**
 * Agent 规划 Todo 工具。
 *
 * Claude 通过 in-process MCP 注册；Pi 使用同名的 TypeBox custom tool。
 * 业务路由、并发校验和事件广播统一复用 planning-agent-operations。
 */

import type { CalendarEventListQuery, CreateCalendarEventInput, CreateTodoInput, TodoListQuery, UpdateCalendarEventInput, UpdateTodoInput } from '@profer/shared'
import { filterDisabledTools } from '@profer/shared'
import {
  createPlanningCalendarEvent,
  createPlanningTodo,
  deletePlanningCalendarEvent,
  getPlanningCalendarEvent,
  getPlanningTodo,
  listPlanningCalendarEvents,
  listPlanningTodos,
  updatePlanningCalendarEvent,
  updatePlanningTodo,
  type PlanningAgentToolContext,
} from './planning-agent-operations'

interface McpToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function jsonError(error: unknown): McpToolResult {
  return jsonResult({ error: error instanceof Error ? error.message : String(error) })
}

function buildSchemas(z: typeof import('zod')['z']) {
  const priority = z.enum(['low', 'medium', 'high'])
  const status = z.enum(['open', 'completed'])
  const reminder = z.object({ triggerAt: z.number().finite().positive() })
  return {
    list: {
      status: status.optional(),
      dueBefore: z.number().finite().positive().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    get: { id: z.string().trim().min(1) },
    calendarList: {
      from: z.number().finite().positive().optional(),
      to: z.number().finite().positive().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    calendarGet: { id: z.string().trim().min(1) },
    calendarCreate: {
      title: z.string().trim().min(1).max(500),
      notes: z.string().optional(),
      startAt: z.number().finite().positive(),
      endAt: z.number().finite().positive().optional(),
      allDay: z.boolean().optional(),
      groupId: z.string().trim().min(1).optional(),
      tagIds: z.array(z.string().trim().min(1)).optional(),
      reminders: z.array(reminder).optional(),
      todoId: z.string().trim().min(1).optional(),
    },
    calendarUpdate: {
      id: z.string().trim().min(1),
      expectedUpdatedAt: z.number().finite().positive(),
      title: z.string().trim().min(1).max(500).optional(),
      notes: z.string().optional(),
      startAt: z.number().finite().positive().optional(),
      endAt: z.number().finite().positive().nullable().optional(),
      allDay: z.boolean().optional(),
      groupId: z.string().trim().min(1).nullable().optional(),
      tagIds: z.array(z.string().trim().min(1)).optional(),
      todoId: z.string().trim().min(1).nullable().optional(),
    },
    calendarDelete: { id: z.string().trim().min(1) },
    create: {
      title: z.string().trim().min(1).max(500),
      notes: z.string().optional(),
      priority: priority.optional(),
      dueAt: z.number().finite().positive().optional(),
      groupId: z.string().trim().min(1).optional(),
      tagIds: z.array(z.string().trim().min(1)).optional(),
      reminders: z.array(reminder).optional(),
      assigneeId: z.string().trim().min(1).optional(),
    },
    update: {
      id: z.string().trim().min(1),
      expectedUpdatedAt: z.number().finite().positive(),
      title: z.string().trim().min(1).max(500).optional(),
      notes: z.string().optional(),
      priority: priority.optional(),
      dueAt: z.number().finite().positive().nullable().optional(),
      groupId: z.string().trim().min(1).nullable().optional(),
      tagIds: z.array(z.string().trim().min(1)).optional(),
      status: status.optional(),
      assigneeId: z.string().trim().min(1).nullable().optional(),
    },
  }
}

export interface PlanningMcpToolContext extends PlanningAgentToolContext {
  /** 预设禁用的规划中心工具短名；规划中心属于 automation 组。 */
  disabledTools?: string[]
}

export async function injectPlanningMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: PlanningMcpToolContext,
): Promise<void> {
  let z: typeof import('zod')['z']
  try {
    ({ z } = await import('zod'))
  } catch {
    z = require('zod').z
  }
  const schemas = buildSchemas(z)

  const tools = [
      sdk.tool(
        'list_todos',
        '列出当前 Agent 项目中的规划 Todo。规划 Todo 与任务图不同，适合记录用户待办和后续事项。',
        schemas.list,
        async (args) => {
          try {
            const query = args as TodoListQuery
            return jsonResult({ todos: await listPlanningTodos(ctx, query) })
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
      sdk.tool(
        'get_todo',
        '读取当前 Agent 项目中某个规划 Todo 的原始最新记录。更新前必须先读取，以获得 expectedUpdatedAt。',
        schemas.get,
        async (args) => {
          try {
            return jsonResult({ todo: await getPlanningTodo(ctx, (args as { id: string }).id) })
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
      sdk.tool(
        'create_todo',
        '在当前 Agent 项目的规划中心创建 Todo。仅在用户目标确实需要记录规划待办时使用。',
        schemas.create,
        async (args) => {
          try {
            const input = args as unknown as Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>
            return jsonResult({ todo: await createPlanningTodo(ctx, input) })
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
      sdk.tool(
        'update_todo',
        '更新当前 Agent 项目的规划 Todo。必须先读取最新 Todo，并把其 updatedAt 作为 expectedUpdatedAt；冲突时重新读取，不要覆盖人工修改。',
        schemas.update,
        async (args) => {
          try {
            return jsonResult({ todo: await updatePlanningTodo(ctx, args as unknown as Omit<UpdateTodoInput, 'workspaceId'>) })
          } catch (error) {
            return jsonError(error)
          }
        },
      ),
      sdk.tool(
        'list_calendar_events',
        '列出当前 Profer 工作区的本地日程。用户未明确要求同步外部日历时，日程默认指这里。',
        schemas.calendarList,
        async (args) => {
          try { return jsonResult({ events: await listPlanningCalendarEvents(ctx, args as CalendarEventListQuery) }) } catch (error) { return jsonError(error) }
        },
      ),
      sdk.tool(
        'get_calendar_event',
        '读取当前 Profer 工作区某个本地日程的最新记录；更新前必须先读取以获得 expectedUpdatedAt。',
        schemas.calendarGet,
        async (args) => {
          try { return jsonResult({ event: await getPlanningCalendarEvent(ctx, (args as { id: string }).id) }) } catch (error) { return jsonError(error) }
        },
      ),
      sdk.tool(
        'create_calendar_event',
        '在当前 Profer 工作区创建本地日程。除非用户明确要求 Google、Outlook 或其他外部日历，否则不要询问日历平台。',
        schemas.calendarCreate,
        async (args) => {
          try { return jsonResult({ event: await createPlanningCalendarEvent(ctx, args as unknown as Omit<CreateCalendarEventInput, 'workspaceId'>) }) } catch (error) { return jsonError(error) }
        },
      ),
      sdk.tool(
        'update_calendar_event',
        '更新当前 Profer 工作区的本地日程；必须先读取最新日程并传入 expectedUpdatedAt，冲突时重新读取。',
        schemas.calendarUpdate,
        async (args) => {
          try { return jsonResult({ event: await updatePlanningCalendarEvent(ctx, args as unknown as Omit<UpdateCalendarEventInput, 'workspaceId'>) }) } catch (error) { return jsonError(error) }
        },
      ),
      sdk.tool(
        'delete_calendar_event',
        '删除当前 Profer 工作区的本地日程。仅在用户明确要求删除时使用。',
        schemas.calendarDelete,
        async (args) => {
          try { return jsonResult({ deleted: await deletePlanningCalendarEvent(ctx, (args as { id: string }).id) }) } catch (error) { return jsonError(error) }
        },
      ),
  ]
  const server = sdk.createSdkMcpServer({
    name: 'planning',
    version: '1.0.0',
    tools: filterDisabledTools(tools, ctx.disabledTools),
  })

  mcpServers.planning = server as unknown as Record<string, unknown>
}
