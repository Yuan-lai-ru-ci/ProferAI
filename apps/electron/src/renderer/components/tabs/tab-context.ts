/**
 * tab-context — 顶栏该展示哪些 Tab
 *
 * 会话 Tab 只与「当前会话的上下文」同屏：Agent 会话带出同根会话的委派子会话与探索分支，
 * Chat 只带出同一对话的工作 Tab（预览 / 浏览器）。
 *
 * 草稿是跨会话可进入的工作页，但不拥有独立会话上下文：从某个会话点击草稿时，沿用进入前的会话 rail，
 * 保留草稿与当前会话 Tab；离开草稿后恢复普通会话过滤。直接从全局入口打开草稿时只显示草稿。
 * 文档类单页（教程 / 自建 FRP 教程 / 全局插件页）仍只渲染自身，不往它的顶栏塞草稿。
 */

import type { AgentSessionMeta } from '@profer/shared'
import { ensureScratchPadTab, type TabItem } from '@/atoms/tab-atoms'

export function selectContextTabs(
  tabs: TabItem[],
  activeTabId: string | null,
  agentSessions: readonly AgentSessionMeta[],
  scratchPadOriginTabId: string | null = null,
): TabItem[] {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  if (!active) return ensureScratchPadTab(tabs)

  // 草稿不是独立会话：从会话进入时沿用来源会话的 rail；直接从全局入口打开时仅显示草稿。
  if (active.type === 'scratch') {
    const originTab = scratchPadOriginTabId
      ? tabs.find((tab) => tab.id === scratchPadOriginTabId)
      : undefined
    if (!originTab || originTab.type === 'scratch') return ensureScratchPadTab([active])
    return selectContextTabs(tabs, originTab.id, agentSessions)
  }

  if (active.type === 'chat') {
    return ensureScratchPadTab(tabs.filter((tab) => tab.sessionId === active.sessionId))
  }

  if (
    active.type === 'agent' ||
    active.type === 'preview' ||
    active.type === 'browser' ||
    (active.type === 'plugin' && active.pluginScope === 'session')
  ) {
    const sessionId = active.sessionId
    const activeSession = agentSessions.find((session) => session.id === sessionId)
    const ownerTab = tabs.find(
      (tab) => (tab.type === 'chat' || tab.type === 'agent') && tab.sessionId === sessionId,
    )
    if (ownerTab?.type === 'chat') {
      return ensureScratchPadTab(tabs.filter((tab) => tab.sessionId === sessionId))
    }
    const rootSessionId =
      activeSession?.parentSessionId ?? activeSession?.explorationParentSessionId ?? sessionId
    const sessionIds = new Set(
      agentSessions
        .filter(
          (session) =>
            session.id === rootSessionId ||
            session.parentSessionId === rootSessionId ||
            session.explorationParentSessionId === rootSessionId,
        )
        .map((session) => session.id),
    )
    sessionIds.add(rootSessionId)
    return ensureScratchPadTab(
      tabs.filter((tab) => sessionIds.has(tab.sessionId) || tab.parentSessionId === rootSessionId),
    )
  }

  return tabs.filter((tab) => tab.id === active.id)
}
