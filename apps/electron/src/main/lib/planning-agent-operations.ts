/**
 * Agent 规划 Todo 操作层。
 *
 * Claude/Pi 共享这里的 workspace 路由、并发校验和事件广播，避免两套 runtime
 * 对本地 SQLite 与团队规划服务产生行为漂移。
 */

import type {
  CreateTodoInput,
  Todo,
  TodoListQuery,
  UpdateTodoInput,
} from '@profer/shared'
import {
  createTodo,
  getTodo,
  listTodos,
  touchTodoSession,
  updateTodo,
} from './planning-manager'
import {
  broadcastPlanningAgentOperation,
  broadcastPlanningChanged,
} from './planning-events'
import { getAgentWorkspace } from './agent-workspace-manager'
import {
  createTeamTodo,
  listTeamTodos,
  updateTeamTodo,
} from './team-planning-service'

export interface PlanningAgentToolContext {
  sessionId: string
  workspaceId?: string
  isTeamWorkspace?: boolean
}

function isTeamContext(ctx: PlanningAgentToolContext): boolean {
  if (!ctx.workspaceId || ctx.isTeamWorkspace === false) return false
  return ctx.isTeamWorkspace === true || getAgentWorkspace(ctx.workspaceId)?.type === 'team'
}

function assertTodoInContext(todo: Todo | undefined, ctx: PlanningAgentToolContext): Todo {
  if (!todo) throw new Error('Todo 不存在')
  if (!ctx.workspaceId && todo.workspaceId) {
    throw new Error('Todo 不属于当前 Agent 项目')
  }
  if (ctx.workspaceId && todo.workspaceId !== ctx.workspaceId) {
    throw new Error('Todo 不属于当前团队工作区')
  }
  return todo
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
  if (isTeamContext(ctx)) {
    return filterTodos(await listTeamTodos(ctx.workspaceId!), query)
  }
  return listTodos({ ...query, workspaceId: ctx.workspaceId })
}

export async function getPlanningTodo(ctx: PlanningAgentToolContext, id: string): Promise<Todo> {
  if (isTeamContext(ctx)) {
    return assertTodoInContext((await listTeamTodos(ctx.workspaceId!)).find((todo) => todo.id === id), ctx)
  }
  return assertTodoInContext(getTodo(id), ctx)
}

export async function createPlanningTodo(ctx: PlanningAgentToolContext, input: Omit<CreateTodoInput, 'sessionId' | 'workspaceId'>): Promise<Todo> {
  const payload: CreateTodoInput = {
    ...input,
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
  }
  const todo = isTeamContext(ctx)
    ? await createTeamTodo(ctx.workspaceId!, payload)
    : createTodo({ ...payload, sessionId: ctx.sessionId })

  broadcastPlanningChanged(['todos', 'reminders'])
  broadcastPlanningAgentOperation({
    sessionId: ctx.sessionId,
    target: 'todo',
    action: 'created',
    title: todo.title,
  })
  return todo
}

export async function updatePlanningTodo(
  ctx: PlanningAgentToolContext,
  input: Omit<UpdateTodoInput, 'workspaceId'>,
): Promise<Todo> {
  await getPlanningTodo(ctx, input.id)
  if (input.expectedUpdatedAt === undefined) {
    throw new Error('更新 Todo 前必须提供 expectedUpdatedAt；请先读取 Todo 的最新记录')
  }

  const payload: UpdateTodoInput = {
    ...input,
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
  }
  const updated = isTeamContext(ctx)
    ? await updateTeamTodo(ctx.workspaceId!, payload)
    : updateTodo(payload)
  if (!updated) throw new Error('Todo 不存在')

  if (!isTeamContext(ctx)) touchTodoSession(updated.id, ctx.sessionId)
  broadcastPlanningChanged(['todos', 'reminders'])
  broadcastPlanningAgentOperation({
    sessionId: ctx.sessionId,
    target: 'todo',
    action: 'updated',
    title: updated.title,
  })
  return updated
}
