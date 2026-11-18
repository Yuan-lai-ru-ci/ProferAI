import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { filterDisabledTools } from '@profer/shared'

export const TASK_GRAPH_SERVER_NAME = 'task-graph'
export const TASK_GRAPH_NAMES = ['profer_task_create', 'profer_task_update', 'profer_task_get', 'profer_task_list'] as const
export type TaskGraphToolName = typeof TASK_GRAPH_NAMES[number]
export const TASK_GRAPH_DESCRIPTIONS: Record<TaskGraphToolName, string> = {
  profer_task_create: '创建当前会话任务图节点；通过 dependsOn 声明前置任务。用此工具替代 TaskCreate。',
  profer_task_update: '更新任务状态、说明或依赖；dependsOn（包括空数组）完整替换依赖。可传读取到的 expectedRevision 防止并发覆盖。',
  profer_task_get: '读取当前会话的一个任务及任务图 revision。',
  profer_task_list: '读取当前会话完整任务图、任务列表和 revision。',
}
export interface TaskGraphToolHost {
  disabledTools?: string[]
  execute(name: TaskGraphToolName, input: Record<string, unknown>, signal?: AbortSignal, operationId?: string): Promise<unknown>
}
export function taskGraphToolDisabled(disabled: readonly string[] | undefined, name: TaskGraphToolName): boolean {
  return disabled?.includes(name) === true || disabled?.includes(`mcp__${TASK_GRAPH_SERVER_NAME}__${name}`) === true
}
export async function loadPiTaskGraphTools(host: TaskGraphToolHost): Promise<ToolDefinition[]> {
  return buildPiTaskGraphTools(await import('@earendil-works/pi-coding-agent'), host)
}
export function buildPiTaskGraphTools(sdk: Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>, host: TaskGraphToolHost): ToolDefinition[] {
  const id = () => Type.String({ minLength: 1, maxLength: 200 })
  const dependencies = () => Type.Optional(Type.Array(id(), { maxItems: 500 }))
  const common = { expectedRevision: Type.Optional(id()), operationId: Type.Optional(id()) }
  const schemas = {
    profer_task_create: Type.Object({ subject: Type.String({ minLength: 1, maxLength: 500 }), description: Type.Optional(Type.String({ maxLength: 50000 })), dependsOn: dependencies(), forkFrom: Type.Optional(id()), ...common }),
    profer_task_update: Type.Object({ taskId: id(), subject: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), description: Type.Optional(Type.String({ maxLength: 50000 })), status: Type.Optional(Type.Union(['pending', 'in_progress', 'completed', 'failed', 'cancelled'].map(value => Type.Literal(value)))), dependsOn: dependencies(), abandonReason: Type.Optional(Type.String({ minLength: 1, maxLength: 5000 })), ...common }),
    profer_task_get: Type.Object({ taskId: id() }),
    profer_task_list: Type.Object({}),
  }
  const tools = TASK_GRAPH_NAMES.filter(name => !taskGraphToolDisabled(host.disabledTools, name)).map(name => sdk.defineTool({
    name: `mcp__${TASK_GRAPH_SERVER_NAME}__${name}`, label: name, description: TASK_GRAPH_DESCRIPTIONS[name], parameters: schemas[name],
    async execute(toolCallId, params, signal) {
      const payload = await host.execute(name, params as Record<string, unknown>, signal, toolCallId)
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], details: payload }
    },
  }))
  return filterDisabledTools(tools, host.disabledTools)
}
