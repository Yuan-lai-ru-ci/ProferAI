/**
 * ExplorationBranchBar — 探索分支 Tab 内的分支条
 *
 * 探索分支从「右侧面板内嵌 Agent」迁为顶栏 Tab 后，原来挂在面板顶部的
 * 来源标注 + 「带回主线」动作移到分支自身的会话视图顶部（30px 细条）：
 * - 标明分叉来源（sourceLabel）；
 * - 「带回主线」把分支最新结论作为 &session: 引用写入父会话草稿。
 *
 * 分支血缘从会话 meta 派生（explorationParentSessionId / explorationSourceMessageId /
 * explorationSourceLabel），不再依赖运行时 Map。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { GitFork, GitMerge } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { markdownToHtml } from '@/lib/markdown-rich-text'
import { buildExplorationReferenceDraft, getLatestExplorationConclusion, mergeExplorationMessages } from '@/lib/exploration-session'
import {
  agentSDKMessagesCacheAtom,
  liveMessagesMapAtom,
  agentSessionDraftsAtom,
  agentSessionDraftHtmlAtom,
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import type { SDKMessage } from '@profer/shared'

function BringBackAction({
  parentSessionId,
  branchSessionId,
  sourceMessageId,
}: {
  parentSessionId: string
  branchSessionId: string
  sourceMessageId: string
}): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const messageCache = useAtomValue(agentSDKMessagesCacheAtom)
  const liveMessages = useAtomValue(liveMessagesMapAtom).get(branchSessionId) ?? []
  const [loadedMessages, setLoadedMessages] = React.useState<SDKMessage[]>([])
  const parentDrafts = useAtomValue(agentSessionDraftsAtom)
  const parentDraftHtml = useAtomValue(agentSessionDraftHtmlAtom)
  const setParentDrafts = useSetAtom(agentSessionDraftsAtom)
  const setParentDraftHtml = useSetAtom(agentSessionDraftHtmlAtom)
  const branchMessages = React.useMemo(
    () => mergeExplorationMessages(loadedMessages, messageCache.get(branchSessionId) ?? []),
    [branchSessionId, loadedMessages, messageCache],
  )
  const allBranchMessages = React.useMemo(
    () => mergeExplorationMessages(branchMessages, liveMessages),
    [branchMessages, liveMessages],
  )
  const conclusion = React.useMemo(
    () => getLatestExplorationConclusion(allBranchMessages, sourceMessageId),
    [allBranchMessages, sourceMessageId],
  )

  React.useEffect(() => {
    if (conclusion || branchMessages.some((message) => (message as { uuid?: unknown }).uuid === sourceMessageId)) return
    const api = window.electronAPI as unknown as {
      getAgentSessionSDKMessages?: (id: string) => Promise<unknown>
    }
    let cancelled = false
    void (api.getAgentSessionSDKMessages?.(branchSessionId) ?? Promise.resolve([]))
      .then((messages) => {
        if (cancelled || !Array.isArray(messages)) return
        setLoadedMessages(messages as SDKMessage[])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [branchSessionId, sourceMessageId, branchMessages, conclusion])

  const handleBringBack = React.useCallback(() => {
    if (!conclusion) {
      toast.info('探索分支还没有可带回的 Agent 结论')
      return
    }
    const title = sessions.find((item) => item.id === branchSessionId)?.title || '探索分支'
    const reference = buildExplorationReferenceDraft(branchSessionId, title)
    const currentDraft = parentDrafts.get(parentSessionId)?.trim() ?? ''
    const currentHtml = parentDraftHtml.get(parentSessionId) || markdownToHtml(parentDrafts.get(parentSessionId) ?? '')
    if (currentDraft.includes(`&session:${branchSessionId}`)) {
      toast.info('该探索分支已经在主线草稿中')
      return
    }
    setParentDrafts((previous) => {
      const next = new Map(previous)
      next.set(parentSessionId, currentDraft ? `${currentDraft}\n\n${reference.markdown}` : reference.markdown)
      return next
    })
    setParentDraftHtml((previous) => {
      const next = new Map(previous)
      next.set(parentSessionId, currentHtml ? `${currentHtml}<p></p>${reference.html}` : reference.html)
      return next
    })
    toast.success('已添加探索引用', { description: '分支 Tab 保持打开；主会话发送后 Agent 会读取该标记。' })
  }, [branchSessionId, conclusion, parentDraftHtml, parentDrafts, parentSessionId, sessions, setParentDraftHtml, setParentDrafts])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 刻意不用 disabled：禁用态按钮不派发事件，tooltip 也无法解释原因。
            改用 aria-disabled + 低透明度，点击时由 handleBringBack 给出 toast 说明。 */}
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-6 flex-shrink-0 gap-1 px-2 text-[11px] active:scale-[0.97]', !conclusion && 'opacity-45')}
          aria-disabled={!conclusion}
          onClick={handleBringBack}
          aria-label="把探索结论带回主线"
        >
          <GitMerge className="size-3" />
          带回主线
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{conclusion ? '将探索后新增内容作为会话引用添加到主线草稿' : '完成一轮新的探索回复后即可带回'}</TooltipContent>
    </Tooltip>
  )
}

/** 分支条：仅当会话确实是探索分支（meta 血缘完整）时渲染，否则返回 null。 */
export function ExplorationBranchBar({ branchSessionId }: { branchSessionId: string }): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const branch = sessions.find((session) => session.id === branchSessionId)
  const parentSessionId = branch?.explorationParentSessionId
  const sourceMessageId = branch?.explorationSourceMessageId
  if (!branch || !parentSessionId || !sourceMessageId) return null
  const sourceLabel = branch.explorationSourceLabel ?? '主线探索节点'
  return (
    <div className="flex h-[30px] flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 text-[11px]">
      <GitFork className="size-3 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium text-foreground/80">{branch.title || '探索分支'}</span>
      <span className="min-w-0 truncate text-muted-foreground/60">· {sourceLabel}</span>
      <div className="min-w-0 flex-1" />
      <BringBackAction
        parentSessionId={parentSessionId}
        branchSessionId={branchSessionId}
        sourceMessageId={sourceMessageId}
      />
    </div>
  )
}
