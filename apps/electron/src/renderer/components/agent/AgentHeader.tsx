/**
 * AgentHeader — Agent 会话探索入口。
 *
 * 会话标题已经收敛到顶部 TabBar；这里保留一个轻量探索菜单，
 * 让关闭右侧 Tab 后仍可从持久化 session 元数据重新打开分支。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Split } from 'lucide-react'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { openExplorationBranchTab } from '@/lib/exploration-tab'
import { getDefaultStore } from 'jotai'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface AgentHeaderProps {
  sessionId: string
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const branches = React.useMemo(
    () => sessions
      .filter((session) => session.explorationParentSessionId === sessionId && !!session.explorationSourceMessageId)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessionId, sessions],
  )

  /** 分支是顶栏 Tab：重开 = 建 Tab 并激活（必要时自动与父会话并排）。 */
  const reopen = React.useCallback((branch: (typeof branches)[number]): void => {
    if (!branch.explorationSourceMessageId) return
    openExplorationBranchTab(getDefaultStore(), sessionId, { sessionId: branch.id, title: branch.title || '探索分支' }, { autoGroup: true })
  }, [sessionId])

  if (branches.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="titlebar-no-drag h-8 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground" aria-label={`打开 ${branches.length} 个探索分支`}>
          <Split className="size-3.5" />
          <span>探索</span>
          {branches.length > 1 && <span className="tabular-nums">{branches.length}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[100] w-64 titlebar-no-drag">
        {branches.map((branch) => (
          <DropdownMenuItem key={branch.id} onSelect={() => reopen(branch)} className="flex items-center gap-2 py-2">
            <Split className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{branch.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  )
}
