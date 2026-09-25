import { useStore } from 'jotai'
import type { ProferPluginPagePlacement, ProferPluginTaskReference } from '@profer/plugin-api'
import { openPluginTab, tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'

export function usePluginPage(): (pluginId: string, pageId: string, title: string, reference?: ProferPluginTaskReference, placement?: ProferPluginPagePlacement) => Promise<void> {
  const store = useStore()
  return async (pluginId, pageId, title, reference, placement = 'tab') => {
    const tabs = store.get(tabsAtom)
    const active = tabs.find((tab) => tab.id === store.get(activeTabIdAtom))
    const currentAgentSessionId = store.get(currentAgentSessionIdAtom)
    const currentConversationId = store.get(currentConversationIdAtom)
    const sessionBoundPlacement = placement === 'tab' || placement === 'sidebar' || placement === 'settings'
    const sessionId: string | undefined = sessionBoundPlacement
      ? reference?.sessionId
        ?? ((active?.type === 'chat' || active?.type === 'agent' || active?.type === 'preview' || active?.type === 'browser' || (active?.type === 'plugin' && active.pluginScope === 'session')) ? active.sessionId : undefined)
        ?? currentAgentSessionId
        ?? currentConversationId
        ?? undefined
      : undefined
    const ownerTab = sessionBoundPlacement && sessionId
      ? tabs.find((tab) => (tab.type === 'chat' || tab.type === 'agent') && tab.sessionId === sessionId)
      : undefined
    const task: ProferPluginTaskReference | undefined = sessionBoundPlacement && sessionId
      ? reference ?? { kind: ownerTab?.type === 'chat' || sessionId === currentConversationId ? 'chat' : 'agent', sessionId }
      : undefined

    await window.electronAPI.activatePluginPage(pluginId, pageId, task, placement)
    const opened = openPluginTab(tabs, { pluginId, pageId, title, sessionId, scope: sessionId ? 'session' : 'global' })
    store.set(tabsAtom, opened.tabs)
    store.set(activeTabIdAtom, opened.activeTabId)
    store.set(settingsOpenAtom, false)

    if (sessionId && task?.kind === 'chat') {
      store.set(appModeAtom, 'chat')
      store.set(currentConversationIdAtom, sessionId)
      store.set(currentAgentSessionIdAtom, null)
      store.set(currentAgentWorkspaceIdAtom, null)
    } else if (sessionId) {
      store.set(appModeAtom, 'agent')
      store.set(currentConversationIdAtom, null)
      store.set(currentAgentSessionIdAtom, sessionId)
    } else {
      store.set(appModeAtom, 'scratch')
      store.set(currentConversationIdAtom, null)
      store.set(currentAgentSessionIdAtom, null)
      store.set(currentAgentWorkspaceIdAtom, null)
    }
  }
}
