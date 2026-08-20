/**
 * Agent 规划 Todo 工具。
 *
 * Claude 通过 in-process MCP 注册；Pi 使用同名的 TypeBox custom tool。
 * 业务路由、并发校验和事件广播统一复用 planning-agent-operations。
 */

import type { CreateTodoInput, TodoListQuery, UpdateTodoInput } from '@profer/shared'
import {
  createPlanningTodo,
  getPlanningTodo,
  listPlanningTodos,
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

export interface PlanningMcpToolContext extends PlanningAgentToolContext {}

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

  const server = sdk.createSdkMcpServer({
    name: 'planning',
    version: '1.0.0',
    tools: [
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
    ],
  })

  mcpServers.planning = server as unknown as Record<string, unknown>
}
