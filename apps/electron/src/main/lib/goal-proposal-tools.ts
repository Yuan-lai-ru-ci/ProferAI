/**
 * 模型主动提议建立 Goal 的工具（对齐 Claude Code 的 ProposeGoal）。
 *
 * 与 `update_goal` 的区别：
 * - `update_goal` 只在 Goal 轮次内部存在，用来汇报本轮结果；
 * - `propose_goal` 在一轮普通对话里存在，用来建议「这件事值得开一个 Goal」。
 *
 * 工具不阻塞当前轮：登记提议后立刻返回，模型继续把手上的活做完；
 * 用户批准后由 GoalSessionService 接管后续轮次。
 */

import { GOAL_PROPOSE_TOOL_NAME } from '@profer/shared'
import type { AgentGoalContract, GoalProposal } from '@profer/shared'
import { goalProposalService, normalizeGoalProposalInput, type GoalProposalPolicy } from './goal-proposal-service'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
type ZodModule = typeof import('zod')

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export interface GoalProposalToolsContext {
  sessionId: string
  /** 当前策略；disabled 时不注入工具。 */
  policy: GoalProposalPolicy
  /** 当前会话是否已经有 Goal；有 Goal 时不需要再提议。 */
  hasActiveGoal: boolean
  /** 计划模式下不提议（此时用户还没确认要做）。 */
  planMode: boolean
  /** 登记成功后通知渲染层（auto 策略下直接创建 Goal 时由调用方处理）。 */
  onPropose: (proposal: GoalProposal, contract?: AgentGoalContract) => void
}

/** 是否应该给这轮对话注入 propose_goal。 */
export function shouldInjectGoalProposalTool(ctx: Pick<GoalProposalToolsContext, 'policy' | 'hasActiveGoal' | 'planMode'>): boolean {
  return ctx.policy !== 'disabled' && !ctx.hasActiveGoal && !ctx.planMode
}

/** Claude runtime 的 Goal 提议工具。 */
export async function injectGoalProposalMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: GoalProposalToolsContext,
): Promise<void> {
  if (!shouldInjectGoalProposalTool(ctx)) return
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'goal_proposal',
    version: '1.0.0',
    tools: [
      sdk.tool(
        GOAL_PROPOSE_TOOL_NAME,
        'Propose creating a long-running Goal for this session. Use only when the work clearly needs multiple iterations (build/verify/iterate) and cannot be finished in this turn. The user must confirm; this tool does not start the Goal by itself and does not block the current turn.',
        {
          objective: z.string().min(1).max(2000).describe('一句话可执行的目标'),
          rationale: z.string().max(1000).describe('为什么需要多轮持续执行，而不是这一轮做完'),
          verification: z.string().max(2000).optional().describe('可验证的验收标准'),
          constraints: z.string().max(2000).optional().describe('必须遵守的约束'),
          stopWhen: z.string().max(2000).optional().describe('什么情况下应该停下来问用户'),
        },
        async (args) => {
          const normalized = normalizeGoalProposalInput(args as Parameters<typeof normalizeGoalProposalInput>[0])
          if (!normalized) return jsonResult({ accepted: false, reason: 'objective 不能为空' })
          if (goalProposalService.hasPending(ctx.sessionId)) {
            const existing = goalProposalService.listForSession(ctx.sessionId)[0]
            return jsonResult({ accepted: false, reason: '该会话已有待确认的 Goal 提议，等待用户确认后再提议', proposalId: existing?.id })
          }
          const created = goalProposalService.add(ctx.sessionId, args as Parameters<typeof goalProposalService.add>[1])
          if (!created) return jsonResult({ accepted: false, reason: 'objective 不能为空' })
          ctx.onPropose(created.proposal, created.contract)
          return jsonResult({
            accepted: true,
            proposalId: created.proposal.id,
            policy: ctx.policy,
            note: ctx.policy === 'auto' ? '已直接创建 Goal，后续轮次由 Goal 控制器接管' : '已提交给用户确认，先继续完成当前这一轮',
          })
        },
      ),
    ],
  })
  mcpServers.goal_proposal = server as unknown as Record<string, unknown>
}
