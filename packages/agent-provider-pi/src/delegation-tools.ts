import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { filterDisabledTools } from '@profer/shared'
import type { CollaborationToolContext, DelegationToolOperations } from '@profer/agent-runtime/delegation-tool-operations'

type PiSdk = Pick<typeof import('@earendil-works/pi-coding-agent'), 'defineTool'>
function result(payload: unknown): AgentToolResult<unknown> { return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload } }

export async function loadPiCollaborationTools(ctx: CollaborationToolContext, operations: DelegationToolOperations, disabledTools: string[] = []): Promise<ToolDefinition[]> {
  return buildPiCollaborationTools(await import('@earendil-works/pi-coding-agent'), ctx, operations, disabledTools)
}

export function buildPiCollaborationTools(sdk: PiSdk, ctx: CollaborationToolContext, operations: DelegationToolOperations, disabledTools: string[] = []): ToolDefinition[] {
  const role = Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('research'), Type.Literal('implement'), Type.Literal('review'), Type.Literal('custom')]))
  const presetReference = Type.Optional(Type.Object({ presetId: Type.String(), presetScope: Type.Union([Type.Literal('builtin-meta'), Type.Literal('user-global'), Type.Literal('workspace')]), workspaceSlug: Type.Optional(Type.String()), presetVersion: Type.Optional(Type.String()) }))
  const placement = Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('child'), Type.Literal('independent')]))
  const relation = Type.Optional(Type.Union([Type.Literal('subtask'), Type.Literal('independent')]))
  const item = Type.Object({ operationId: Type.Optional(Type.String({ maxLength: 200 })), title: Type.Optional(Type.String()), role, task: Type.String(), expectedOutput: Type.Optional(Type.String()), modelId: Type.Optional(Type.String()), presetReference, placement, relation })
  const tools: ToolDefinition[] = [
    sdk.defineTool({ name: 'mcp__collaboration__list_available_agent_models', label: '列出可用模型', description: '列出当前Core可用于委派的模型。', parameters: Type.Object({}), async execute() { return result(operations.listAvailableModels(ctx)) } }),
    sdk.defineTool({ name: 'mcp__collaboration__delegate_agent', label: '委派子Agent', description: '在当前Core创建隔离的子会话。多个可用预设时须按职责指定 presetReference。', parameters: item, async execute(_id, params) { return result(await operations.delegate({ ...ctx, operationId: _id }, params as Parameters<DelegationToolOperations['delegate']>[1])) } }),
    sdk.defineTool({ name: 'mcp__collaboration__delegate_agents', label: '批量委派', description: '批量创建隔离子会话。多个可用预设时每项须按职责指定 presetReference。', parameters: Type.Object({ operationId: Type.Optional(Type.String({ maxLength: 200 })), sharedContext: Type.Optional(Type.String()), items: Type.Array(item, { minItems: 1, maxItems: 50 }) }), async execute(_id, params) { return result(await operations.delegateBatch({ ...ctx, operationId: _id }, params as Parameters<DelegationToolOperations['delegateBatch']>[1])) } }),
    sdk.defineTool({ name: 'mcp__collaboration__wait_for_delegations', label: '等待委派', description: '等待子任务完成；遇阻塞会提前返回。', parameters: Type.Object({ delegationIds: Type.Optional(Type.Array(Type.String())), mode: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('any')])), minCompleted: Type.Optional(Type.Number()), timeoutSeconds: Type.Optional(Type.Number()) }), async execute(_id, params, signal) { return result(await operations.wait({ ...ctx, signal: signal ?? ctx.signal }, params as Parameters<DelegationToolOperations['wait']>[1])) } }),
    sdk.defineTool({ name: 'mcp__collaboration__list_delegations', label: '列出委派', description: '列出当前父会话的委派。', parameters: Type.Object({ includeCompleted: Type.Optional(Type.Boolean()) }), async execute(_id, params) { return result(operations.list(ctx, params as { includeCompleted?: boolean })) } }),
    sdk.defineTool({ name: 'mcp__collaboration__get_delegation_results', label: '读取委派结果', description: '读取委派结果。', parameters: Type.Object({ delegationIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }) }), async execute(_id, params) { return result(operations.getResults(ctx, (params as { delegationIds: string[] }).delegationIds)) } }),
    sdk.defineTool({ name: 'mcp__collaboration__stop_delegation', label: '停止委派', description: '停止当前父会话的一项子任务。', parameters: Type.Object({ delegationId: Type.String() }), async execute(_id, params) { return result(await operations.stop(ctx, (params as { delegationId: string }).delegationId)) } }),
    sdk.defineTool({ name: 'mcp__collaboration__stop_delegations', label: '批量停止委派', description: '停止当前父会话子任务。', parameters: Type.Object({ delegationIds: Type.Optional(Type.Array(Type.String())) }), async execute(_id, params) { return result(await operations.stopMany(ctx, (params as { delegationIds?: string[] }).delegationIds)) } }),
    sdk.defineTool({ name: 'mcp__collaboration__answer_delegation_question', label: '回答子任务阻塞', description: '回答当前父会话子任务的问题或权限请求。', parameters: Type.Object({ blockedEventId: Type.String(), answer: Type.Optional(Type.String()), answers: Type.Optional(Type.Record(Type.String(), Type.String())), permissionBehavior: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('deny')])) }), async execute(_id, params) { return result(await operations.answer(ctx, params as Parameters<DelegationToolOperations['answer']>[1])) } }),
    sdk.defineTool({ name: 'mcp__collaboration__continue_delegation', label: '继续委派', description: '在原子会话追加指令并续跑。', parameters: Type.Object({ operationId: Type.Optional(Type.String({ maxLength: 200 })), delegationId: Type.String(), message: Type.String() }), async execute(_id, params) { return result(await operations.continue({ ...ctx, operationId: _id }, params as Parameters<DelegationToolOperations['continue']>[1])) } }),
  ]
  return filterDisabledTools(tools, disabledTools)
}
