import { receiveHandoff, subscribeHandoffRecovery } from './window-tab-handoff'
import { useEffect } from 'react'
import { useStore } from 'jotai'
import type { createStore } from 'jotai/vanilla'
import type { AppWindowSession, AppWindowSummary, MainWindowBootstrap } from '@profer/shared'
import { appWindowsAtom, windowBootstrapAtom } from '../atoms/app-windows'
import { tabsAtom, activeTabIdAtom, openTab, type TabItem } from '../atoms/tab-atoms'
import { coreTargetsAtom, coreSessionNavigationPhaseAtom } from '../atoms/core-target-atoms'
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom, agentSessionsAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '../atoms/agent-atoms'
import { conversationDraftsAtom, currentConversationIdAtom } from '../atoms/chat-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { getWindowBootstrap } from './window-bootstrap'

type Store = ReturnType<typeof createStore>

export function collectWindowSessions(tabs: TabItem[]): AppWindowSession[] {
  return tabs.flatMap(tab => tab.type === 'chat' || tab.type === 'agent'
    ? [{ type: tab.type, sessionId: tab.sessionId }] : [])
}

export function hasOtherSessionWindow(windows: AppWindowSummary[], ownId: string | undefined, session: AppWindowSession): boolean {
  return windows.some(window => !window.isPrimary && window.windowId !== ownId
    && window.sessions.some(item => item.type === session.type && item.sessionId === session.sessionId))
}

/** 已关闭或聚焦失败时恢复本地导航，调用方不必吞掉打开意图。 */
export async function focusSessionOrOpenLocal(focus: () => Promise<boolean>, openLocal: () => void): Promise<void> {
  try { if (await focus()) return } catch { /* 目标窗口消失时按本地打开处理。 */ }
  openLocal()
}

/** 目录恢复完成后再注入交接；不走跨窗口聚焦路由。 */
export function applyInitialWindowTab(store: Store, tab: MainWindowBootstrap['initialTab'], activate = true): void {
  if (!tab) return
  if (tab.type === 'agent') {
    if (tab.draft !== undefined) store.set(agentSessionDraftsAtom, previous => new Map(previous).set(tab.sessionId, tab.draft!))
    if (tab.draftHtml !== undefined) store.set(agentSessionDraftHtmlAtom, previous => new Map(previous).set(tab.sessionId, tab.draftHtml!))
    if (!activate) {
      store.set(tabsAtom, openTab(store.get(tabsAtom), tab).tabs)
      return
    }
    store.set(currentAgentSessionIdAtom, tab.sessionId)
    store.set(currentConversationIdAtom, null)
    const meta = store.get(agentSessionsAtom).find(item => item.id === tab.sessionId)
    if (meta?.workspaceId) store.set(currentAgentWorkspaceIdAtom, meta.workspaceId)
  } else {
    if (tab.draft !== undefined) store.set(conversationDraftsAtom, previous => new Map(previous).set(tab.sessionId, tab.draft!))
    if (!activate) {
      store.set(tabsAtom, openTab(store.get(tabsAtom), tab).tabs)
      return
    }
    store.set(currentConversationIdAtom, tab.sessionId)
    store.set(currentAgentSessionIdAtom, null)
  }
  const result = openTab(store.get(tabsAtom), tab)
  store.set(tabsAtom, result.tabs)
  store.set(activeTabIdAtom, result.activeTabId)
  store.set(appModeAtom, tab.type)
}

export function AppWindowsInitializer(): null {
  const store = useStore()
  useEffect(() => {
    let disposed = false
    const stopHandoffs = window.electronAPI.onWindowTabHandoff(event => receiveHandoff(store,event))
    let receivedSnapshot = false
    const unsubscribe = window.electronAPI.onAppWindowsChanged(windows => {
      receivedSnapshot = true
      store.set(appWindowsAtom, windows)
    })
    void getWindowBootstrap().then(bootstrap => {
      if (disposed) return
      if (!receivedSnapshot) store.set(appWindowsAtom, bootstrap.openWindows)
      for (const event of bootstrap.recoverableHandoffs ?? []) receiveHandoff(store,event,true)
    })
    // 不把恢复过程中的空 Tab 列表上报，避免覆盖主进程的交接关联。
    const report = (): void => {
      if (!store.get(windowBootstrapAtom) || store.get(coreSessionNavigationPhaseAtom) !== 'ready') return
      void window.electronAPI.reportWindowSessions(collectWindowSessions(store.get(tabsAtom))).catch(console.error)
    }
    const stopRecovery = subscribeHandoffRecovery(store)
    const stops = [tabsAtom, windowBootstrapAtom, coreSessionNavigationPhaseAtom].map(item => store.sub(item, report))
    report()
    return () => { disposed = true; stopHandoffs(); stopRecovery(); unsubscribe(); stops.forEach(stop => stop()) }
  }, [store])
  return null
}
