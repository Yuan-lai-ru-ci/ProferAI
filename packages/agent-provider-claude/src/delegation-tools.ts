import { filterDisabledTools } from '@profer/shared'
import type { ZodType } from 'zod'
import type { DelegationContext, DelegateInput, DelegationToolOperations } from '@profer/agent-runtime/delegation-tool-operations'

type ClaudeSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>

/** 工具定义只依赖SDK；所属Core提供执行、持久化与审批操作。 */
export async function injectClaudeDelegationTools(
  sdk: ClaudeSdk, servers: Record<string, Record<string, unknown>>, ctx: DelegationContext,
  operations: DelegationToolOperations, disabledTools: string[] = [],
): Promise<void> {
  const { z } = await import('zod')
  const reference = z.object({
    presetId: z.string().min(1).max(200), presetScope: z.enum(['builtin-meta', 'user-global', 'workspace']),
    workspaceSlug: z.string().optional(), presetVersion: z.string().optional(),
  }).optional()
  const fields = {
    operationId: z.string().min(1).max(200).optional(),
    title: z.string().optional(), role: z.enum(['explore', 'research', 'implement', 'review', 'custom']).optional(),
    task: z.string().trim().min(1), expectedOutput: z.string().optional(), modelId: z.string().min(1).optional(), presetReference: reference,
    placement: z.enum(['current', 'child', 'independent']).optional(), relation: z.enum(['subtask', 'independent']).optional(),
  }
  const schemas: Record<string, Record<string, ZodType>> = {
    list_available_agent_models: {}, delegate_agent: fields,
    delegate_agents: { operationId: z.string().min(1).max(200).optional(), sharedContext: z.string().optional(), items: z.array(z.object(fields)).min(1).max(50) },
    wait_for_delegations: { delegationIds: z.array(z.string()).optional(), mode: z.enum(['all', 'any']).optional(), minCompleted: z.number().int().min(1).max(50).optional(), timeoutSeconds: z.number().int().min(1).max(7200).optional() },
    list_delegations: { includeCompleted: z.boolean().optional() }, get_delegation_results: { delegationIds: z.array(z.string()).min(1).max(50) },
    stop_delegation: { delegationId: z.string().min(1) }, stop_delegations: { delegationIds: z.array(z.string()).optional() },
    answer_delegation_question: { blockedEventId: z.string().min(1), answers: z.record(z.string(), z.string()).optional(), permissionBehavior: z.enum(['allow', 'deny']).optional() },
    continue_delegation: { operationId: z.string().min(1).max(200).optional(), delegationId: z.string().min(1), message: z.string().trim().min(1) },
  }
  const descriptions: Record<string, string> = {
    list_available_agent_models: '列出当前Core可委派的模型。', delegate_agent: '创建独立执行上下文；current/child为附属任务，independent不随父级停止。',
    delegate_agents: '批量创建隔离子会话。', wait_for_delegations: '等待委派进展；阻塞时提前返回。', list_delegations: '列出当前父会话的委派。',
    get_delegation_results: '读取委派结果。', stop_delegation: '停止一项委派。', stop_delegations: '停止多项委派。',
    answer_delegation_question: '回答子Agent阻塞；权限允许仍须宿主审批。', continue_delegation: '在原子会话追加指令并续跑。',
  }
  async function dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === 'list_available_agent_models') return operations.listAvailableModels(ctx)
    if (name === 'delegate_agent') return operations.delegate(ctx, args as unknown as DelegateInput)
    if (name === 'delegate_agents') return operations.delegateBatch(ctx, args as unknown as Parameters<DelegationToolOperations['delegateBatch']>[1])
    if (name === 'wait_for_delegations') return operations.wait(ctx, args as Parameters<DelegationToolOperations['wait']>[1])
    if (name === 'list_delegations') return operations.list(ctx, args as { includeCompleted?: boolean })
    if (name === 'get_delegation_results') return operations.getResults(ctx, args.delegationIds as string[])
    if (name === 'stop_delegation') return operations.stop(ctx, String(args.delegationId))
    if (name === 'stop_delegations') return operations.stopMany(ctx, args.delegationIds as string[] | undefined)
    if (name === 'answer_delegation_question') return operations.answer(ctx, { blockedEventId: String(args.blockedEventId), answers: args.answers as Record<string, string> | undefined, permissionBehavior: args.permissionBehavior as 'allow' | 'deny' | undefined })
    return operations.continue(ctx, args as Parameters<DelegationToolOperations['continue']>[1])
  }
  const tools = Object.entries(descriptions).map(([name, description]) => sdk.tool(name, description, schemas[name]!, async args => {
    const payload = await dispatch(name, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
  }))
  servers.collaboration = sdk.createSdkMcpServer({ name: 'collaboration', version: '1.0.0', tools: filterDisabledTools(tools, disabledTools) }) as unknown as Record<string, unknown>
}
