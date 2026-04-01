/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + SplitContainer] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页 + 分屏，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const showRightPanel = appMode === 'agent' && !!currentSessionId

  return (
    <AppShellProvider value={contextValue}>
      {/* 可拖动标题栏区域，用于窗口拖动 */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-50" />

      <div className="shell-bg h-screen w-screen flex overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
        {/* 左侧边栏：可折叠，带圆角和内边距 */}
        <div className="p-2 pr-0 relative z-[60]">
          <LeftSidebar />
        </div>

        {/* 中间容器：relative z-[60] 使其在 z-50 拖动区域之上 */}
        <div className="flex-1 min-w-0 p-2 relative z-[60]">
          {/* 主内容区域（TabBar + SplitContainer） */}
          <MainArea />
        </div>

        {/* 右侧边栏：Agent 文件面板，带圆角和内边距 */}
        {showRightPanel && (
          <div className="p-2 pl-0 relative z-[60]">
            <RightSidePanel />
          </div>
        )}
      </div>
    </AppShellProvider>
  )
}
