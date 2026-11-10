import * as React from 'react'
import { useAtomValue } from 'jotai'
import { activeTabIdAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import { useCloseTab } from '@/hooks/useCloseTab'
import type { BrowserViewState } from '@profer/shared'
import { BrowserPanel } from './BrowserPanel'

/** 每个可见 Pane 投影自己的页面；同一会话可以同时展示两页，不改变 Agent 工作指针。 */
export function browserPageState(state: BrowserViewState | null, tabId: string): BrowserViewState | null {
  if (!state) return null
  const page = state.tabs.find(page => page.tabId === tabId)
  if (!page) return null
  return { ...state, ...page, activeTabId: tabId,
    visible: page.visible ?? false,
    canGoBack: page.canGoBack ?? (state.activeTabId === tabId && state.canGoBack),
    canGoForward: page.canGoForward ?? (state.activeTabId === tabId && state.canGoForward),
    translated: page.translated ?? false,
    loadError: page.loadError ?? null,
    find: page.find ?? null,
    dialog: page.dialog ?? null,
  }
}

export function BrowserTabContent({ tabId, sessionId, browserTabId }: { tabId: string; sessionId: string; browserTabId: string }): React.ReactElement {
  const browserState = useAtomValue(browserStateMapAtom).get(sessionId) ?? null
  const state = React.useMemo(() => browserPageState(browserState, browserTabId), [browserState, browserTabId])
  const activeId = useAtomValue(activeTabIdAtom)
  const activeView = useAtomValue(activeViewAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const searchOpen = useAtomValue(searchDialogOpenAtom)
  const ownsShortcuts = activeId === tabId && activeView === 'conversations' && !settingsOpen && !searchOpen
  const { requestClose } = useCloseTab()
  return <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-content-area">
    <BrowserPanel sessionId={sessionId} state={state} visible active={ownsShortcuts} onClose={() => requestClose(tabId)} />
  </div>
}
