/**
 * useOpenSession — 统一的"打开/聚焦会话 Tab"操作
 *
 * 封装 openTab + setTabs + setActiveTabId + setAppMode + setCurrentXxxId，
 * 确保所有打开会话的入口都能正确同步 appMode 和 currentSessionId。
 */

import * as React from 'react'
import { promoteMru } from '@profer/shared'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  openTab,
  tabMruAtom,
  type TabType,
} from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import {
  currentAgentSessionIdAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { upsertAgentSession } from '@/lib/agent-session-list'
import { isAgentWorkspaceIdVisible } from '@/lib/product-feature-flags'

type OpenSessionFn = (type: TabType, sessionId: string, title: string, parentSessionId?: string) => void

export function useOpenSession(): OpenSessionFn {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setTabMru = useSetAtom(tabMruAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)

  return React.useCallback(
    (type: TabType, sessionId: string, title: string, parentSessionId?: string): void => {
      const knownSession = type === 'agent' || type === 'preview'
        ? agentSessions.find((session) => session.id === sessionId)
        : undefined
      if ((type === 'agent' || type === 'preview')
        && !isAgentWorkspaceIdVisible(knownSession?.workspaceId, agentWorkspaces)) {
        return
      }

      // 子会话血缘（委派 parentSessionId / 探索 explorationParentSessionId）：
      // 显式参数优先，再从会话 meta 派生，保证所有打开路径产出一致的子会话 Tab。
      const lineageParentId = parentSessionId
        ?? knownSession?.parentSessionId
        ?? knownSession?.explorationParentSessionId
      const result = openTab(tabs, {
        type,
        sessionId,
        title,
        ...(lineageParentId ? { parentSessionId: lineageParentId } : {}),
      })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      if (type === 'chat' || type === 'agent' || type === 'preview') {
        setTabMru((previous) => promoteMru(previous, sessionId))
      }
      setAutomationForm({ open: false, draft: null })
      setActiveView('conversations')

      if (type === 'chat') {
        setAppMode('chat')
        setCurrentConversationId(sessionId)
      } else if (type === 'agent' || type === 'preview') {
        setAppMode('agent')
        setCurrentAgentSessionId(sessionId)

        // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
        setUnviewedCompleted((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })

        // 打开查看即消费持久化的「标记未读」：清除 completedButUnconfirmed，重启后绿标不"复活"。
        // IPC 幂等（未标记会话无副作用）；用 map 更新保持列表顺序不变。
        window.electronAPI.clearAgentCompletionState(sessionId)
          .then((meta) => {
            setAgentSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)))
          })
          .catch(console.error)

        // 同步 workspaceId，确保与 TabBar 切换行为一致
        const session = agentSessions.find((s) => s.id === sessionId)
        if (session?.workspaceId) {
          setCurrentAgentWorkspaceId(session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
        } else {
          // 归档会话不在活跃列表：拉取单条 meta 兜底，供 AgentView 等消费者读取
          window.electronAPI.getAgentSessionMeta(sessionId).then((meta) => {
            if (!meta) return
            setAgentSessions((prev) => upsertAgentSession(prev, meta))
            if (meta.workspaceId) {
              setCurrentAgentWorkspaceId(meta.workspaceId)
              window.electronAPI.updateSettings({
                agentWorkspaceId: meta.workspaceId,
              }).catch(console.error)
            }
          }).catch(console.error)
        }
      } else {
        setAppMode('scratch')
        setCurrentConversationId(null)
        setCurrentAgentSessionId(null)
      }
    },
    [tabs, setTabs, setActiveTabId, setTabMru, setAutomationForm, setActiveView, setAppMode, setCurrentConversationId, setCurrentAgentSessionId, agentSessions, agentWorkspaces, setCurrentAgentWorkspaceId, setUnviewedCompleted, setAgentSessions],
  )
}
