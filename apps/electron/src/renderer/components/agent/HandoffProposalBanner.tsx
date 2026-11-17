/**
 * HandoffProposalBanner — 模型主动提议「交接对话」的确认卡片
 *
 * 触发源是 Agent 自己调用 propose_handoff（上下文过长、阶段告一段落，或用户在对话里
 * 要求「交接一下」后模型判断该交接）。与 GoalProposalBanner 同位置同风格、**不阻塞**：
 * 模型这一轮继续跑完，用户点确认才由主进程撰写交接文档并新建会话；点 X / 忽略只丢弃提议。
 *
 * 卡片刻意不进 AgentView 的 hasBannerOverlay —— 那会把输入框整块藏起来。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowRightLeft, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { agentSessionStreamingStateAtomFamily, allPendingHandoffProposalsAtom } from '@/atoms/agent-atoms'
import { handoffInFlightAtomFamily } from '@/atoms/session-handoff'
import { useSessionHandoff } from '@/hooks/useSessionHandoff'
import type { HandoffProposal } from '@profer/shared'

interface HandoffProposalBannerProps {
  sessionId: string
}

export function HandoffProposalBanner({ sessionId }: HandoffProposalBannerProps): React.ReactElement | null {
  // 按传入的 sessionId 取提议：不能用「当前会话」的 atom，否则多面板会显示别的会话的卡片。
  const [allProposals, setAllProposals] = useAtom(allPendingHandoffProposalsAtom)
  const proposals = allProposals.get(sessionId) ?? []
  const proposal = proposals[0] ?? null
  const [submitting, setSubmitting] = React.useState<'accept' | 'dismiss' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const setInFlight = useSetAtom(handoffInFlightAtomFamily(sessionId))
  const { applyHandoffResult } = useSessionHandoff(sessionId)
  // 本会话自己的流式状态：交接文档撰写要往同一份 JSONL 追加，运行中不能并发。
  const running = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))?.running ?? false

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

  const respond = React.useCallback(async (target: HandoffProposal, accepted: boolean): Promise<void> => {
    if (submitting) return
    setSubmitting(accepted ? 'accept' : 'dismiss')
    setError(null)
    // 交接期间把共享进行态顶上：否则用户还能点工具栏按钮，再跑一次交接。
    if (accepted) setInFlight(true)
    try {
      const result = await window.electronAPI.respondHandoffProposal(target.id, accepted)
      // 主进程确认分支已经 createHandoffSession，这里只做渲染层的切标签 / 首轮 prompt。
      if (accepted && result) applyHandoffResult(result)
      removeLocally(target.id)
    } catch (err) {
      // 撰写文档 / 新建会话失败时保留卡片，让用户看到原因后重试。
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (accepted) setInFlight(false)
      setSubmitting(null)
    }
  }, [submitting, setInFlight, applyHandoffResult, removeLocally])

  if (!proposal) return null
  const pendingCount = proposals.length

  return (
    <div className="handoff-proposal-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      <div className="px-4 pt-3 pb-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ArrowRightLeft className="size-3.5 text-primary" />
            建议交接这个会话
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
        <p className="text-sm text-foreground whitespace-pre-wrap break-words">{proposal.reason}</p>
        {proposal.nextSteps && (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            建议下一步：{proposal.nextSteps}
          </p>
        )}
        <p className="text-xs text-muted-foreground/70">
          确认后会整理交接文档、新建会话并切过去；当前会话保持不变。
        </p>
        {running && (
          <p className="text-xs text-muted-foreground/70">本轮还在运行，结束后才能确认交接。</p>
        )}
        {error && <p role="alert" className="text-xs text-destructive">交接失败：{error}</p>}
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
          disabled={submitting !== null || running}
          onClick={() => { void respond(proposal, true) }}
        >
          {submitting === 'accept' ? '交接中…' : running ? '等本轮结束' : '交接并新建会话'}
        </Button>
      </div>
    </div>
  )
}
