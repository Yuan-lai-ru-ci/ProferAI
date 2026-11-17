/**
 * 「交接对话」提议服务
 *
 * 模型在普通对话里判断「这个会话该换一个干净上下文继续」时，调用 propose_handoff
 * 提交一条提议；宿主把它交给用户确认，确认后才真正撰写交接文档并新建会话。
 *
 * 形状对齐 goal-proposal-service：工具只登记、立即返回，不阻塞当前轮；
 * 提议只存内存（重启后模型会重新评估，持久化反而会让用户看到过期卡片）。
 */

import { randomUUID } from 'node:crypto'
import type { HandoffProposal } from '@profer/shared'

/** 单个会话最多保留的待确认提议数，防止模型反复提议刷屏。 */
export const MAX_PENDING_HANDOFF_PROPOSALS = 3

export interface HandoffProposalInput {
  reason: unknown
  nextSteps?: unknown
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

/** 解析 propose_handoff 参数；理由为空视为无效提议。 */
export function normalizeHandoffProposalInput(input: HandoffProposalInput): { reason: string; nextSteps?: string } | null {
  const reason = text(input.reason, 1000)
  if (!reason) return null
  const nextSteps = text(input.nextSteps, 2000)
  return nextSteps ? { reason, nextSteps } : { reason }
}

export class HandoffProposalService {
  private readonly pending = new Map<string, HandoffProposal>()

  /** 登记提议；同一会话超过上限时丢弃最旧的一条。 */
  add(sessionId: string, input: HandoffProposalInput): HandoffProposal | null {
    const normalized = normalizeHandoffProposalInput(input)
    if (!normalized) return null
    const proposal: HandoffProposal = {
      id: randomUUID(),
      sessionId,
      reason: normalized.reason,
      nextSteps: normalized.nextSteps,
      createdAt: Date.now(),
    }
    const existing = this.listForSession(sessionId)
    if (existing.length >= MAX_PENDING_HANDOFF_PROPOSALS) {
      const oldest = [...existing].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.pending.delete(oldest.id)
    }
    this.pending.set(proposal.id, proposal)
    return proposal
  }

  /** 读取但不出队：交接失败时保留提议，卡片才能显示原因并重试。 */
  peek(proposalId: string): HandoffProposal | null {
    return this.pending.get(proposalId) ?? null
  }

  /** 会话已有待确认提议时不再重复登记（模型每轮都会看到同一会话）。 */
  hasPending(sessionId: string): boolean {
    return this.listForSession(sessionId).length > 0
  }

  list(): HandoffProposal[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  listForSession(sessionId: string): HandoffProposal[] {
    return this.list().filter((proposal) => proposal.sessionId === sessionId)
  }

  remove(proposalId: string): HandoffProposal | null {
    const proposal = this.pending.get(proposalId)
    if (!proposal) return null
    this.pending.delete(proposalId)
    return proposal
  }

  clearSession(sessionId: string): void {
    for (const [id, proposal] of this.pending) {
      if (proposal.sessionId === sessionId) this.pending.delete(id)
    }
  }
}

export const handoffProposalService = new HandoffProposalService()
