/**
 * DiffPanelTabBar — 右侧面板顶部 Tab 栏
 *
 * 切换「工作区文件」和「代码改动」两个视图。
 * 样式完全复用主 TabBar 的浏览器标签页风格。
 * 「代码改动」Tab 有未暂存变更时显示小圆点提示。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { agentDiffUnseenChangesAtom } from '@/atoms/agent-atoms'

interface DiffPanelTabBarProps {
  activeTab: 'files' | 'changes'
  onTabChange: (tab: 'files' | 'changes') => void
}

export function DiffPanelTabBar({ activeTab, onTabChange }: DiffPanelTabBarProps): React.ReactElement {
  const unseenChanges = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenChanges = useSetAtom(agentDiffUnseenChangesAtom)

  const handleChangesClick = () => {
    setUnseenChanges(false)
    onTabChange('changes')
  }

  return (
    <div className="flex items-end h-[34px] tabbar-bg relative flex-shrink-0">
      <div className="absolute inset-0 titlebar-drag-region" />
      <div className="relative flex items-end flex-1 titlebar-no-drag">
        <button
          type="button"
          onClick={() => onTabChange('files')}
          className={cn(
            'flex-1 px-3 h-[34px] rounded-t-lg text-xs transition-colors select-none cursor-pointer',
            'border-t border-l border-r',
            activeTab === 'files'
              ? 'bg-content-area text-foreground border-border/50'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50',
          )}
        >
          工作区文件
        </button>
        <button
          type="button"
          onClick={handleChangesClick}
          className={cn(
            'flex-1 px-3 h-[34px] rounded-t-lg text-xs transition-colors select-none cursor-pointer relative',
            'border-t border-l border-r',
            activeTab === 'changes'
              ? 'bg-content-area text-foreground border-border/50'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50',
          )}
        >
          {unseenChanges && activeTab !== 'changes' && (
            <span className="absolute left-2 top-1/2 -translate-y-1/2 size-2 rounded-full bg-primary ring-1 ring-background" />
          )}
          代码改动
        </button>
      </div>
    </div>
  )
}
