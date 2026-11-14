/**
 * HandoffSuggestion — 输入框上方的「建议新开会话」提示条
 *
 * 挂在 `AgentView` 的 `composer-stack` 里（与 BackgroundTaskControls、
 * RuntimeProcessPanel、消息队列同一位置），所以它天然浮在输入卡正上方，
 * 复用既有的叠层与间距，不需要另造一套布局。
 *
 * 与输入工具栏的常驻「交接」按钮共用 `useSessionHandoff`：这里只负责
 * 「什么时候建议」和「怎么显示」，点下去的动作由 hook 统一执行。
 * 建议条有阈值闸门，工具栏按钮没有 —— 用户随时可以主动交接。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ArrowRightLeft, Loader2, X } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'
import { agentSessionStreamingStateAtomFamily } from '@/atoms/agent-atoms'
import {
  agentSessionTurnCountFamily,
  handoffDismissedAtom,
  handoffSuggestTurnCountAtom,
} from '@/atoms/session-handoff'
import { resolveHandoffSuggestion } from '@/lib/handoff-suggestion'
import { useSessionHandoff } from '@/hooks/useSessionHandoff'

interface HandoffSuggestionProps {
  sessionId: string
}

export function HandoffSuggestion({ sessionId }: HandoffSuggestionProps): React.ReactElement | null {
  const threshold = useAtomValue(handoffSuggestTurnCountAtom)
  const turnCount = useAtomValue(agentSessionTurnCountFamily(sessionId))
  const streamingState = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
  const [dismissedIds, setDismissedIds] = useAtom(handoffDismissedAtom)
  const { inFlight, startHandoff } = useSessionHandoff(sessionId)

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

      <Button size="sm" className="h-7 shrink-0 px-2.5 text-[12px]" disabled={inFlight} onClick={() => void startHandoff()}>
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
