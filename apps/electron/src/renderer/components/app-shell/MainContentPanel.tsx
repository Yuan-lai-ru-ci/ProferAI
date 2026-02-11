/**
 * MainContentPanel - 主内容面板
 *
 * 根据当前活跃视图显示不同内容：
 * - conversations: 根据 App 模式显示 Chat/Agent 内容（带滑动过渡）
 * - settings: 显示设置面板
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { cn } from '@/lib/utils'
import { Panel } from './Panel'
import { ChatView } from '@/components/chat'
import { AgentView } from '@/components/agent'
import { SettingsPanel } from '@/components/settings'

export function MainContentPanel(): React.ReactElement {
  const mode = useAtomValue(appModeAtom)
  const activeView = useAtomValue(activeViewAtom)

  return (
    <Panel
      variant="grow"
      className="bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl border border-border/50"
    >
      {activeView === 'settings' ? (
        <SettingsPanel />
      ) : (
        <div className="relative h-full w-full overflow-hidden">
          <div
            className={cn(
              'absolute inset-0 transition-transform duration-300 ease-in-out',
              mode === 'chat' ? 'translate-x-0' : '-translate-x-full'
            )}
          >
            <ChatView />
          </div>
          <div
            className={cn(
              'absolute inset-0 transition-transform duration-300 ease-in-out',
              mode === 'agent' ? 'translate-x-0' : 'translate-x-full'
            )}
          >
            <AgentView />
          </div>
        </div>
      )}
    </Panel>
  )
}
