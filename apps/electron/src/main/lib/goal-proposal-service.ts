/**
 * Goal 提议服务（对齐 Claude Code 的 ProposeGoal）
 *
 * 模型在长任务里发现「这其实是多轮持续目标」时，可以调用 propose_goal 提出建议；
 * 宿主把提议交给用户确认，批准后才真正创建 Goal。三种策略：
 * - `alwaysAsk`（默认）：每次都要用户点确认；
 * - `auto`：直接创建 Goal，用户仍可在状态栏暂停/清除；
 * - `disabled`：模型不能提议，工具直接拒绝。
 *
 * 与 AskUserQuestion 的区别：提议不阻塞模型当前轮次——模型继续把手上这轮做完，
 * 用户确认后再由 GoalSessionService 接管后续轮次。这样即使提议一直没人理，
 * 会话也不会卡在等待状态。
 */

import { randomUUID } from 'node:crypto'
import type { AgentGoalContract, GoalProposal, GoalProposalPolicy } from '@profer/shared'

export type { GoalProposalPolicy }

export const DEFAULT_GOAL_PROPOSAL_POLICY: GoalProposalPolicy = 'alwaysAsk'

/** 单个会话最多保留的待确认提议数，防止模型反复提议刷屏。 */
export const MAX_PENDING_GOAL_PROPOSALS = 3

export function normalizeGoalProposalPolicy(value: unknown): GoalProposalPolicy {
  return value === 'auto' || value === 'disabled' ? value : DEFAULT_GOAL_PROPOSAL_POLICY
}

export interface GoalProposalInput {
  objective: unknown
  rationale?: unknown
  verification?: unknown
  constraints?: unknown
  stopWhen?: unknown
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

/** 解析 propose_goal 工具参数；目标为空视为无效提议。 */
export function normalizeGoalProposalInput(input: GoalProposalInput): { objective: string; rationale: string; contract?: AgentGoalContract } | null {
  const objective = text(input.objective, 2000)
  if (!objective) return null
  const rationale = text(input.rationale, 1000) ?? ''
  const verification = text(input.verification, 2000)
  const constraints = text(input.constraints, 2000)
  const stopWhen = text(input.stopWhen, 2000)
  const contract = verification || constraints || stopWhen ? { verification, constraints, stopWhen } : undefined
  return { objective, rationale, contract }
}

type Pending = { proposal: GoalProposal; contract?: AgentGoalContract }

/**
 * 待确认提议队列。
 *
 * 只保存在内存：提议是「当前这轮对话里的一个动作」，应用重启后模型会重新评估，
 * 持久化反而会让用户看到过期的提议。
 */
export class GoalProposalService {
  private readonly pending = new Map<string, Pending>()

  /** 登记提议；同一会话超过上限时丢弃最旧的一条。 */
  add(sessionId: string, input: GoalProposalInput): { proposal: GoalProposal; contract?: AgentGoalContract } | null {
    const normalized = normalizeGoalProposalInput(input)
    if (!normalized) return null
    const proposal: GoalProposal = {
      id: randomUUID(),
      sessionId,
      objective: normalized.objective,
      rationale: normalized.rationale,
      verification: normalized.contract?.verification,
      constraints: normalized.contract?.constraints,
      stopWhen: normalized.contract?.stopWhen,
      createdAt: Date.now(),
    }
    const existing = [...this.pending.values()].filter((item) => item.proposal.sessionId === sessionId)
    if (existing.length >= MAX_PENDING_GOAL_PROPOSALS) {
      const oldest = existing.sort((a, b) => a.proposal.createdAt - b.proposal.createdAt)[0]
      if (oldest) this.pending.delete(oldest.proposal.id)
    }
    this.pending.set(proposal.id, { proposal, contract: normalized.contract })
    return { proposal, contract: normalized.contract }
  }

  /**
   * 读取但不出队：真正创建 Goal 成功后才移除，
   * 失败时保留提议，用户可以在卡片上看到原因后重试。
   */
  peek(proposalId: string): Pending | null {
    return this.pending.get(proposalId) ?? null
  }

  /** 读取并移除一条待确认提议（批准与忽略都要移除，避免重复消费）。 */
  take(proposalId: string): Pending | null {
    const item = this.pending.get(proposalId)
    if (!item) return null
    this.pending.delete(proposalId)
    return item
  }

  /** 会话已有待确认提议时不再重复登记（模型每轮都会看到同一任务）。 */
  hasPending(sessionId: string): boolean {
    return [...this.pending.values()].some((item) => item.proposal.sessionId === sessionId)
  }

  list(): GoalProposal[] {
    return [...this.pending.values()].map((item) => item.proposal).sort((a, b) => a.createdAt - b.createdAt)
  }

  listForSession(sessionId: string): GoalProposal[] {
    return this.list().filter((proposal) => proposal.sessionId === sessionId)
  }

  /** 删除某条提议（用户忽略或会话结束时）。 */
  remove(proposalId: string): GoalProposal | null {
    const item = this.pending.get(proposalId)
    if (!item) return null
    this.pending.delete(proposalId)
    return item.proposal
  }

  /** 会话被关闭/删除时清空它的提议。 */
  clearSession(sessionId: string): void {
    for (const [id, item] of this.pending) {
      if (item.proposal.sessionId === sessionId) this.pending.delete(id)
    }
  }
}

export const goalProposalService = new GoalProposalService()
