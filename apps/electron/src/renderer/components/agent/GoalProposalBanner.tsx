/**
 * GoalProposalBanner — 模型主动提议建立 Goal 的确认卡片（对齐 Claude Code 的 ProposeGoal）
 *
 * 与 AskUserBanner 同位置同风格，但**不阻塞**：模型当前这一轮继续跑，
 * 用户点「建立 Goal」后由主进程创建 Goal 并接管后续轮次；点「忽略」只是丢弃这次提议。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Target, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { allPendingGoalProposalsAtom } from '@/atoms/agent-atoms'
import type { GoalProposal } from '@profer/shared'

interface GoalProposalBannerProps {
  sessionId: string
}

/** 把提议压成一行摘要，供侧栏/通知复用。 */
export function describeGoalProposal(proposal: GoalProposal): string {
  return proposal.objective
}

export function GoalProposalBanner({ sessionId }: GoalProposalBannerProps): React.ReactElement | null {
  // 按传入的 sessionId 取提议：不能用「当前会话」的 atom，否则独立窗口/多面板会显示别的会话的卡片。
  const [allProposals, setAllProposals] = useAtom(allPendingGoalProposalsAtom)
  const proposals = allProposals.get(sessionId) ?? []
  const proposal = proposals[0] ?? null
  const [submitting, setSubmitting] = React.useState<'accept' | 'dismiss' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // 消费掉当前提议后展示下一条时，不要带上一条的失败提示。
  React.useEffect(() => { setError(null) }, [proposal?.id])

  const removeLocally = React.useCallback((proposalId: string): void => {
    setAllProposals((prev) => {
      const map = new Map(prev)
      const current = map.get(sessionId) ?? []
      const next = current.filter((item) => item.id !== proposalId)
      if (next.length > 0) map.set(sessionId, next)
      else map.delete(sessionId)
      return map
    })
  }, [sessionId, setAllProposals])

  const respond = React.useCallback(async (target: GoalProposal, accepted: boolean): Promise<void> => {
    if (submitting) return
    setSubmitting(accepted ? 'accept' : 'dismiss')
    setError(null)
    try {
      await window.electronAPI.respondGoalProposal(target.id, accepted)
      removeLocally(target.id)
    } catch (err) {
      // 创建失败（例如会话已有未完成 Goal）时保留卡片，让用户看到原因后自己决定。
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }, [removeLocally, submitting])

  if (!proposal) return null
  const pendingCount = proposals.length

  return (
    <div className="goal-proposal-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      <div className="px-4 pt-3 pb-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Target className="size-3.5 text-primary" />
            建议为这件事建立一个 Goal
          </span>
          <div className="flex items-center gap-1.5">
            {pendingCount > 1 && <span className="text-xs text-muted-foreground">(+{pendingCount - 1})</span>}
            <button
              type="button"
              className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={() => { void respond(proposal, false) }}
              title="忽略这条建议"
              aria-label="忽略这条建议"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-[38vh] overflow-y-auto overscroll-contain px-4 pb-2 space-y-1.5">
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">{proposal.objective}</p>
        {proposal.rationale && <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{proposal.rationale}</p>}
        {(proposal.verification || proposal.constraints || proposal.stopWhen) && (
          <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {proposal.verification && <div className="flex gap-1.5"><dt className="shrink-0 text-muted-foreground/70">验收</dt><dd className="min-w-0 break-words">{proposal.verification}</dd></div>}
            {proposal.constraints && <div className="flex gap-1.5"><dt className="shrink-0 text-muted-foreground/70">约束</dt><dd className="min-w-0 break-words">{proposal.constraints}</dd></div>}
            {proposal.stopWhen && <div className="flex gap-1.5"><dt className="shrink-0 text-muted-foreground/70">停止</dt><dd className="min-w-0 break-words">{proposal.stopWhen}</dd></div>}
          </dl>
        )}
        {error && <p role="alert" className="text-xs text-destructive">创建失败：{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-1.5 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">当前这一轮会继续跑，不影响你正在做的事</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={submitting !== null}
          onClick={() => { void respond(proposal, false) }}
        >
          忽略
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={submitting !== null}
          onClick={() => { void respond(proposal, true) }}
        >
          {submitting === 'accept' ? '创建中…' : '建立 Goal'}
        </Button>
      </div>
    </div>
  )
}
