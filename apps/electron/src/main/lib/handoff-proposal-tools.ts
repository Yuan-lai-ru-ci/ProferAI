/**
 * 模型主动提议「交接对话」的工具（Claude runtime）
 *
 * 与手动交接按钮的区别：按钮是用户直接发起，这里是模型自己判断该换会话了
 * （或用户在对话里要求「交接一下」，模型据此调用），提交后必须等用户点确认。
 * 工具不阻塞当前轮：登记提议后立刻返回，模型继续把手上的活做完。
 */

import { HANDOFF_PROPOSE_TOOL_NAME } from '@profer/shared'
import type { HandoffProposal } from '@profer/shared'
import { handoffProposalService, normalizeHandoffProposalInput, type HandoffProposalInput } from './handoff-proposal-service'

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')
type ZodModule = typeof import('zod')

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export interface HandoffProposalToolsContext {
  sessionId: string
  /** 计划模式下不提议（用户还没确认要做什么）。 */
  planMode: boolean
  /** 登记成功后通知渲染层出卡片。 */
  onPropose: (proposal: HandoffProposal) => void
}

/** 是否应该给这轮对话注入 propose_handoff。 */
export function shouldInjectHandoffProposalTool(ctx: Pick<HandoffProposalToolsContext, 'planMode'>): boolean {
  return !ctx.planMode
}

export async function injectHandoffProposalMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: HandoffProposalToolsContext,
): Promise<void> {
  if (!shouldInjectHandoffProposalTool(ctx)) return
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }
  const server = sdk.createSdkMcpServer({
    name: 'handoff_proposal',
    version: '1.0.0',
    tools: [
      sdk.tool(
        HANDOFF_PROPOSE_TOOL_NAME,
        'Propose handing this conversation over to a fresh session. Use when the context is getting long/noisy, when a substantial phase of work has just finished, or when the user explicitly asks to hand off / start a fresh session with a summary. The host writes a handoff document and opens a new session ONLY after the user confirms the card; this tool does not switch sessions and does not block the current turn.',
        {
          reason: z.string().min(1).max(1000).describe('为什么现在该交接：上下文、阶段进展或用户要求'),
          nextSteps: z.string().max(2000).optional().describe('建议接手者接下来先做什么'),
        },
        async (args) => {
          const normalized = normalizeHandoffProposalInput(args as HandoffProposalInput)
          if (!normalized) return jsonResult({ accepted: false, reason: 'reason 不能为空' })
          if (handoffProposalService.hasPending(ctx.sessionId)) {
            const existing = handoffProposalService.listForSession(ctx.sessionId)[0]
            return jsonResult({ accepted: false, reason: '该会话已有待确认的交接提议，等待用户确认后再提议', proposalId: existing?.id })
          }
          const proposal = handoffProposalService.add(ctx.sessionId, args as HandoffProposalInput)
          if (!proposal) return jsonResult({ accepted: false, reason: 'reason 不能为空' })
          ctx.onPropose(proposal)
          return jsonResult({
            accepted: true,
            proposalId: proposal.id,
            note: '已提交给用户确认，先继续完成当前这一轮；用户确认后才会撰写交接文档并新建会话',
          })
        },
      ),
    ],
  })
  mcpServers.handoff_proposal = server as unknown as Record<string, unknown>
}
