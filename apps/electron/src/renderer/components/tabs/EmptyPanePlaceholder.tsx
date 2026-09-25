/**
 * EmptyPanePlaceholder — 组合里空着的那一栏
 *
 * 为什么需要它：把「当前会话」拖进分区时，**不自动补位**——另一栏先空着，由用户自己挑。
 * 空栏本身就是那个选择入口：可以从下拉里选一个已打开的会话，也可以把任意会话标签拖进来。
 *
 * 只提供组合白名单内的候选（agent / chat / preview），并排除已在栏里的标签；
 * 没有候选时给出"先从左侧栏打开一个会话"的指引，而不是给一个点不动的按钮。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Bot, Columns2, FileText, Globe2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { tabsAtom, type TabItem } from '@/atoms/tab-atoms'
import { isGroupEligibleTab } from '@/atoms/tab-group-atoms'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface EmptyPanePlaceholderProps {
  /** 已经在组合里的标签 id（不再作为候选） */
  excludeTabIds: string[]
  onPick: (tabId: string) => void
  onDissolve: () => void
}

function CandidateIcon({ tab }: { tab: TabItem }): React.ReactElement | null {
  if (tab.type === 'agent') return <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  if (tab.type === 'chat') return <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  // 预览标签是一个文件：给个文件图标，避免候选列表里出现没有类型标识的行
  if (tab.type === 'preview') return <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  if (tab.type === 'browser') return <Globe2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  return null
}

export function EmptyPanePlaceholder({
  excludeTabIds,
  onPick,
  onDissolve,
}: EmptyPanePlaceholderProps): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const excluded = React.useMemo(() => new Set(excludeTabIds), [excludeTabIds])
  const candidates = React.useMemo(
    () => tabs.filter((tab) => !excluded.has(tab.id) && isGroupEligibleTab(tab)),
    [excluded, tabs],
  )

  return (
    <div
      data-empty-pane="true"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center titlebar-no-drag"
    >
      <Columns2 className="size-5 text-muted-foreground/45" aria-hidden="true" />

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">这一栏还空着</p>
        <p className="text-[11px] text-muted-foreground/60">
          把一个会话标签拖到这里，或从下面选一个
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs">
            选择会话
          </Button>
        </DropdownMenuTrigger>
        {/* z-[100]：主区外壳自身是 z-[60]/z-[70]，Radix 默认 z-50 会被整个面板盖住 */}
        <DropdownMenuContent align="center" className="z-[100] max-h-72 w-56 overflow-y-auto">
          {candidates.length > 0 ? (
            candidates.map((tab) => (
              <DropdownMenuItem
                key={tab.id}
                className="gap-2 text-xs"
                onSelect={() => onPick(tab.id)}
              >
                <CandidateIcon tab={tab} />
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              </DropdownMenuItem>
            ))
          ) : (
            <div className={cn('px-2 py-1.5 text-[11px] text-muted-foreground')}>
              没有其他已打开的会话，先从左侧栏打开一个
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={onDissolve}
        className="rounded text-[11px] text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
      >
        解散分栏
      </button>
    </div>
  )
}
