import { z } from 'zod'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { RuntimeCanUseTool } from '@profer/agent-runtime'
import { TASK_GRAPH_NAMES, TASK_GRAPH_DESCRIPTIONS, TASK_GRAPH_SERVER_NAME, taskGraphToolDisabled, loadPiTaskGraphTools, type TaskGraphToolName } from '@profer/agent-provider-pi/task-graph-tools'
import type { CoreTaskGraphContext, CoreTaskGraphService } from './task-graph-service'

type ClaudeSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>
export const CORE_TASK_GRAPH_CLAUDE_TOOL_NAMES = TASK_GRAPH_NAMES.map(name => `mcp__${TASK_GRAPH_SERVER_NAME}__${name}`)
/** Pi/Claude 装配时屏蔽内存/SDK原生任务工具，所有任务归属Core图。 */
export const CORE_TASK_GRAPH_REPLACED_TOOL_NAMES = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'] as const
export interface CoreTaskGraphProviderContext extends CoreTaskGraphContext {
  /** 绑定本次运行的 prepared.canUseTool；不能使用无审批的替代函数。 */
  canUseTool: RuntimeCanUseTool
}
function signalFor(context: CoreTaskGraphContext, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal
}
/** Pi adapter 已统一调用 prepared.canUseTool；此处不重复询问。 */
export async function loadCorePiTaskGraphTools(service: CoreTaskGraphService, context: CoreTaskGraphContext): Promise<ToolDefinition[]> {
  return loadPiTaskGraphTools({ disabledTools: context.disabledTools ? [...context.disabledTools] : undefined,
    execute: (name, input, signal, operationId) => service.execute({ ...context, signal: signalFor(context, signal) }, name, input, operationId) })
}
/** Claude MCP handler 显式通过 Core 审批；与 Pi 共用同一业务 service。 */
export function createCoreClaudeTaskGraphMcpServer(sdk: ClaudeSdk, service: CoreTaskGraphService, context: CoreTaskGraphProviderContext) {
  const id = z.string().min(1).max(200)
  const common = { expectedRevision: id.optional(), operationId: id.optional() }
  const schemas = {
    profer_task_create: { subject: z.string().min(1).max(500), description: z.string().max(50000).optional(), dependsOn: z.array(id).max(500).optional(), forkFrom: id.optional(), ...common },
    profer_task_update: { taskId: id, subject: z.string().min(1).max(500).optional(), description: z.string().max(50000).optional(), status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(), dependsOn: z.array(id).max(500).optional(), abandonReason: z.string().min(1).max(5000).optional(), ...common },
    profer_task_get: { taskId: id }, profer_task_list: {},
  }
  function tool(name: TaskGraphToolName) {
    return sdk.tool(name, TASK_GRAPH_DESCRIPTIONS[name], schemas[name], async (input, extra) => {
      const extraSignal = extra && typeof extra === 'object' && 'signal' in extra && extra.signal instanceof AbortSignal ? extra.signal : undefined
      const signal = signalFor(context, extraSignal)
      signal.throwIfAborted()
      const decision = await context.canUseTool(`mcp__${TASK_GRAPH_SERVER_NAME}__${name}`, input, { signal })
      if (decision.behavior !== 'allow') throw new Error(decision.message)
      signal.throwIfAborted()
      const payload = await service.execute({ ...context, signal }, name, decision.updatedInput ?? input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
    })
  }
  return sdk.createSdkMcpServer({ name: TASK_GRAPH_SERVER_NAME, version: '1.0.0', tools: TASK_GRAPH_NAMES.filter(name => !taskGraphToolDisabled(context.disabledTools, name)).map(tool) })
}
