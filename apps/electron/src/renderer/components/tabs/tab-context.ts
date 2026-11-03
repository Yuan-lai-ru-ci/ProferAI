/**
 * tab-context — 顶栏该展示哪些 Tab
 *
 * 会话 Tab 只与「当前会话的上下文」同屏：Agent 会话带出同根会话的委派子会话与探索分支，
 * Chat 只带出同一对话的工作 Tab（预览 / 浏览器）。
 *
 * 草稿不属于任何会话上下文，是全局固定入口：任何会话上下文的过滤结果都必须保留它，
 * 并固定排在会话 Tab 之前。回归前这里直接把 `tabs` 按会话过滤，草稿会随过滤一起消失，
 * 顶栏只剩会话 Tab（用户看到的就是「草稿没了」）。
 *
 * 文档类单页（教程 / 自建 FRP 教程 / 全局插件页）仍只渲染自身，不往它的顶栏塞草稿。
 */

import type { AgentSessionMeta } from '@profer/shared'
import { ensureScratchPadTab, type TabItem } from '@/atoms/tab-atoms'

export function selectContextTabs(
  tabs: TabItem[],
  activeTabId: string | null,
  agentSessions: readonly AgentSessionMeta[],
): TabItem[] {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null
  if (!active) return ensureScratchPadTab(tabs)

  if (active.type === 'chat') {
    return ensureScratchPadTab(tabs.filter((tab) => tab.sessionId === active.sessionId))
  }

  const sessionBoundPlugin = active.type === 'plugin' && active.pluginScope === 'session'
  if (
    active.type === 'agent' ||
    active.type === 'preview' ||
    active.type === 'browser' ||
    sessionBoundPlugin
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
