/**
 * HandoffSuggestion — 输入框上方的「建议新开会话」提示条
 *
 * 挂在 `AgentView` 的 `composer-stack` 里（与 BackgroundTaskControls、
 * RuntimeProcessPanel、消息队列同一位置），所以它天然浮在输入卡正上方，
 * 复用既有的叠层与间距，不需要另造一套布局。
 *
 * 点击后由主进程完成「撰写交接文档 → 新建会话」，渲染层只做三件事：
 * 把新会话塞进列表、打开标签页、把首轮 prompt 交给它。
 * 首轮刻意只要求「读文档 + 复述计划」，不直接执行下一步——否则新会话会在
 * 用户还没看过内容的情况下就开始花钱改代码。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowRightLeft, Loader2, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { toast } from 'sonner'
import type { AgentSessionHandoffResult } from '@profer/shared'
import {
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentSessionStreamingStateAtomFamily,
} from '@/atoms/agent-atoms'
import {
  agentSessionTurnCountFamily,
  handoffDismissedAtom,
  handoffSuggestTurnCountAtom,
} from '@/atoms/session-handoff'
import { resolveHandoffSuggestion } from '@/lib/handoff-suggestion'
import { useOpenSession } from '@/hooks/useOpenSession'

/**
 * 新会话首轮 prompt：只要它「读 + 复述」，不要它「动手」。
 *
 * `additionalDirectories` 里会带上交接文档所在目录，所以这里用绝对路径引用
 * 才不会因为 cwd 之外而读不到。
 */
function buildBootstrapPrompt(result: AgentSessionHandoffResult): string {
  return `已从上一个会话交接过来，交接文档：${result.handoffPath}

请先读取这份文档，然后**只做确认，先不要动手**：
1. 用 3-5 条要点复述你接手的目标、已经完成的部分、以及下一步建议；
2. 指出文档里含糊、缺失，或你认为需要我确认的地方；
3. 等我确认之后再开始执行。`
}

interface HandoffSuggestionProps {
  sessionId: string
}

export function HandoffSuggestion({ sessionId }: HandoffSuggestionProps): React.ReactElement | null {
  const threshold = useAtomValue(handoffSuggestTurnCountAtom)
  const turnCount = useAtomValue(agentSessionTurnCountFamily(sessionId))
  const streamingState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const [dismissedIds, setDismissedIds] = useAtom(handoffDismissedAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const openSession = useOpenSession()
  const [inFlight, setInFlight] = React.useState(false)

  // 取本会话自己的流式状态，而不是全局「当前会话」的那一份：后台标签页也挂着
  // 这个组件的实例，用全局值会让它按另一个会话的占用率做判断。
  // 口径与 ContextUsageBadge 一致：inputTokens 已含缓存读写，直接除以窗口。
  const contextRatio = streamingState?.inputTokens && streamingState.contextWindow
    ? streamingState.inputTokens / streamingState.contextWindow
    : 0

  const suggestion = resolveHandoffSuggestion({
    turnCount,
    threshold,
    contextRatio,
    streaming: streamingState?.running ?? false,
    dismissed: dismissedIds.has(sessionId),
    inFlight,
  })

  if (!suggestion.visible) return null

  const hint = suggestion.reason === 'contextPressure'
    ? `上下文已用到 ${Math.round(contextRatio * 100)}%，再聊下去会触发压缩`
    : `已经聊了 ${turnCount} 轮，适合换一个干净上下文继续`

  const handleDismiss = (): void => {
    setDismissedIds((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }

  const handleCreate = async (): Promise<void> => {
    if (inFlight) return
    setInFlight(true)
    try {
      const result = await window.electronAPI.createAgentHandoffSession(sessionId)
      setAgentSessions((prev) => (
        prev.some((session) => session.id === result.session.id) ? prev : [result.session, ...prev]
      ))
      // 交接完成后旧会话不再提示：用户刚做过这个动作，立刻再劝一次只会变成噪音。
      handleDismiss()
      openSession('agent', result.session.id, result.session.title)
      setPendingPrompt({
        sessionId: result.session.id,
        message: buildBootstrapPrompt(result),
        additionalDirectories: [result.handoffDir],
      })
      if (result.handoffSource === 'transcript') {
        toast.warning('交接文档由转录自动生成（模型撰写未成功），建议先核对内容')
      }
    } catch (error) {
      console.error('[会话交接] 创建交接会话失败:', error)
      toast.error('交接失败，请重试')
      setInFlight(false)
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-border/35 px-3 pt-2.5 pb-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {inFlight ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowRightLeft className="size-3.5" />}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">
          {inFlight ? '正在撰写交接文档…' : '建议开个新会话继续'}
        </p>
        <p className="truncate text-[12px] text-muted-foreground">
          {inFlight ? '生成完成会自动切到新会话，旧会话保持原样' : `${hint}，新会话会带上交接文档`}
        </p>
      </div>

      <Button size="sm" className="h-7 shrink-0 px-2.5 text-[12px]" disabled={inFlight} onClick={() => void handleCreate()}>
        新开会话
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            disabled={inFlight}
            onClick={handleDismiss}
            aria-label="不再提示"
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>本次不再提示（可在设置里关闭该功能）</TooltipContent>
      </Tooltip>
    </div>
  )
}
