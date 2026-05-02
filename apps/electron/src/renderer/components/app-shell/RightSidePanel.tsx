/**
 * RightSidePanel — 右侧边栏容器
 *
 * 在 Agent 模式下显示文件面板，样式与 LeftSidebar 一致。
 * 从全局 atom 读取当前会话 ID 和路径。
 * 管理「工作区文件 / 代码改动」Tab 切换。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import {
  currentAgentSessionIdAtom,
  agentSessionPathMapAtom,
  agentDiffPanelTabAtom,
} from '@/atoms/agent-atoms'
import { SidePanel } from '@/components/agent/SidePanel'
import { registerShortcut } from '@/lib/shortcut-registry'

export function RightSidePanel(): React.ReactElement | null {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setDiffPanelTabMap = useSetAtom(agentDiffPanelTabAtom)

  // 仅在 Agent 模式且有当前会话时显示
  if (appMode !== 'agent' || !currentSessionId) {
    return null
  }

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const activeTab = diffPanelTabMap.get(currentSessionId) ?? 'files'

  const setActiveTab = React.useCallback((tab: 'files' | 'changes') => {
    setDiffPanelTabMap((prev) => {
      const map = new Map(prev)
      map.set(currentSessionId, tab)
      return map
    })
  }, [currentSessionId, setDiffPanelTabMap])

  // 注册 Cmd+Shift+D 快捷键
  React.useEffect(() => {
    return registerShortcut('toggle-diff-panel', () => {
      setDiffPanelTabMap((prev) => {
        const map = new Map(prev)
        const current = map.get(currentSessionId) ?? 'files'
        map.set(currentSessionId, current === 'files' ? 'changes' : 'files')
        return map
      })
    })
  }, [currentSessionId, setDiffPanelTabMap])

  return (
    <SidePanel
      sessionId={currentSessionId}
      sessionPath={sessionPath}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
