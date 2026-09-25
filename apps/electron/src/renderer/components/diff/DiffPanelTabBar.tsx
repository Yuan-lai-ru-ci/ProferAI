/**
 * DiffPanelTabBar — 右侧面板顶部 Tab 栏
 *
 * 切换「会话文件」「工作区文件」和「代码改动」三个视图。最右侧有关闭按钮。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FileDiff, FolderOpen, FolderTree, PanelRightClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { interfaceVariantAtom } from '@/atoms/theme'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { agentDiffUnseenChangesAtom, currentAgentSessionIdAtom, type AgentSidePanelTab } from '@/atoms/agent-atoms'

type DiffPanelTab = AgentSidePanelTab

interface DiffPanelTabBarProps {
  activeTab: DiffPanelTab
  onTabChange: (tab: DiffPanelTab) => void
  onClose?: () => void
}

interface PreviousTabState {
  sessionId: string | null
  activeTab: DiffPanelTab
}

/**
 * 文件视图单个 Tab。
 *
 * 两种形态：
 * - 常规（无探索分支）：文字 Tab，flex-1 平分整行宽度。
 * - 紧凑（有探索分支）：图标 Tab，固定窄宽，把剩余宽度让给探索分支 Tab 自适应伸展；
 *   此时文字语义由 tooltip 与 aria-label 承载。
 */
function FileViewTabButton({
  active,
  isClassic,
  label,
  icon,
  onClick,
  compact = false,
  badge = false,
}: {
  active: boolean
  isClassic: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
  compact?: boolean
  /** 待查看标记：文字形态在标签前，图标形态在图标右上角 */
  badge?: boolean
}): React.ReactElement {
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'relative flex items-center h-[40px] text-xs transition-colors select-none cursor-pointer',
        'border-t border-l border-r',
        isClassic ? 'rounded-t-lg' : 'rounded-none',
        compact
          ? 'w-11 shrink-0 justify-center'
          : 'min-w-0 flex-1 justify-center gap-1 overflow-hidden px-3',
        active
          ? isClassic ? 'bg-content-area text-foreground border-border/50' : 'app-tab-active text-foreground border-border/80'
          : isClassic ? 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50' : 'app-tab-inactive text-muted-foreground border-transparent hover:text-foreground',
      )}
    >
      {compact ? (
        <>
          {icon}
          {badge && (
            <span className="absolute right-2.5 top-2 size-1.5 rounded-full bg-primary ring-1 ring-background" />
          )}
        </>
      ) : (
        <>
          {badge && <span className="size-2 shrink-0 rounded-full bg-primary ring-1 ring-background" />}
          <span className="truncate">{label}</span>
        </>
      )}
    </button>
  )

  // 仅图标形态需要 tooltip 解释语义；文字形态自带标签
  if (!compact) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function DiffPanelTabBar({ activeTab, onTabChange, onClose }: DiffPanelTabBarProps): React.ReactElement {
  const unseenMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenMap = useSetAtom(agentDiffUnseenChangesAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const isClassic = interfaceVariant === 'classic'
  const unseenChanges = unseenMap.get(currentSessionId ?? '') ?? false
  const prevTabStateRef = React.useRef<PreviousTabState>({ sessionId: currentSessionId, activeTab })

  const clearUnseen = React.useCallback((sessionId = currentSessionId) => {
    if (!sessionId) return
    setUnseenMap((prev) => {
      if (prev.get(sessionId) === false) return prev
      const m = new Map(prev)
      m.set(sessionId, false)
      return m
    })
  }, [currentSessionId, setUnseenMap])

  // 同一会话内，从「文件改动」切走时，说明用户已经看过当前改动。
  React.useEffect(() => {
    const previous = prevTabStateRef.current
    if (previous.sessionId === currentSessionId && previous.activeTab === 'changes' && activeTab !== 'changes') {
      clearUnseen(currentSessionId)
    }
    prevTabStateRef.current = { sessionId: currentSessionId, activeTab }
  }, [activeTab, currentSessionId, clearUnseen])

  const handleChangesClick = () => {
    clearUnseen()
    if (activeTab !== 'changes') {
      onTabChange('changes')
    }
  }

  return (
    <div className="flex items-end h-[40px] tabbar-bg relative flex-shrink-0">
      <div className="absolute inset-0 titlebar-drag-region" />
      <div className="relative flex min-w-0 items-end flex-1 titlebar-no-drag overflow-x-auto scrollbar-none">
        <FileViewTabButton
          active={activeTab === 'session'}
          isClassic={isClassic}
          label="会话文件"
          icon={<FolderOpen className="size-3.5" />}
          onClick={() => onTabChange('session')}
        />
        <FileViewTabButton
          active={activeTab === 'workspace'}
          isClassic={isClassic}
          label="工作区文件"
          icon={<FolderTree className="size-3.5" />}
          onClick={() => onTabChange('workspace')}
        />
        <FileViewTabButton
          active={activeTab === 'changes'}
          isClassic={isClassic}
          label="文件改动"
          icon={<FileDiff className="size-3.5" />}
          badge={unseenChanges && activeTab !== 'changes'}
          onClick={handleChangesClick}
        />
      </div>
      {/* 折叠钮始终固定在右侧，不随大量探索 Tab 横向滚走。 */}
      {onClose && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClose}
              className="relative flex items-center justify-center size-[32px] mr-1 rounded text-muted-foreground hover:text-foreground transition-colors shrink-0 titlebar-no-drag"
            >
              <PanelRightClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">折叠右侧工作区 ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
