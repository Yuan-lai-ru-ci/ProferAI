import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { getRegisteredShortcutBindings, invokeRegisteredShortcut, subscribeShortcutRegistry } from '@/lib/shortcut-registry'
import type { BrowserShortcutContext } from '@profer/shared'

/** 可信主界面与原生 guest 共用同一命令注册表，不合成页面键盘事件。 */
export function BrowserShortcutBridge(): null {
  const store = useStore()
  const activeTabId = useAtomValue(activeTabIdAtom)
  const tabs = useAtomValue(tabsAtom)
  const view = useAtomValue(activeViewAtom)
  const settings = useAtomValue(settingsOpenAtom)
  const search = useAtomValue(searchDialogOpenAtom)
  const scopeId = React.useRef(crypto.randomUUID())
  const revision = React.useRef(0)
  const contextRef = React.useRef<BrowserShortcutContext | null>(null)
  React.useEffect(() => {
    const api = window.electronAPI
    if (!api.setBrowserShortcutContext || !api.onBrowserShortcut) return
    let active = true
    let scheduled = false
    const publish = (): void => {
      scheduled = false
      if (!active) return
      const tab = store.get(tabsAtom).find(item => item.id === store.get(activeTabIdAtom))
      const modal = document.querySelector('[aria-modal="true"][data-state="open"], [role="dialog"][aria-modal="true"]')
      const enabled = store.get(activeViewAtom) === 'conversations' && !store.get(settingsOpenAtom) && !store.get(searchDialogOpenAtom) && !modal
      const target = enabled && tab?.type === 'browser' && tab.browserTabId ? { sessionId: tab.sessionId, tabId: tab.browserTabId } : undefined
      const context: BrowserShortcutContext = { scopeId: scopeId.current, revision: ++revision.current,
        ...(target ? { target } : {}), bindings: enabled ? getRegisteredShortcutBindings() : [] }
      contextRef.current = context
      api.setBrowserShortcutContext(context)
    }
    const schedule = (): void => { if (!scheduled) { scheduled = true; queueMicrotask(publish) } }
    const unsubscribe = subscribeShortcutRegistry(schedule)
    const unsubscribeShortcut = api.onBrowserShortcut(event => {
      const context = contextRef.current
      if (!context || context.scopeId !== event.scopeId || context.revision !== event.revision
        || context.target?.sessionId !== event.sessionId || context.target.tabId !== event.tabId) return
      const tab = store.get(tabsAtom).find(item => item.id === store.get(activeTabIdAtom))
      if (tab?.type !== 'browser' || tab.sessionId !== event.sessionId || tab.browserTabId !== event.tabId
        || store.get(activeViewAtom) !== 'conversations' || store.get(settingsOpenAtom) || store.get(searchDialogOpenAtom)) return
      invokeRegisteredShortcut(event.shortcutId)
    })
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-modal', 'data-state'] })
    schedule()
    return () => {
      active = false; observer.disconnect(); unsubscribe(); unsubscribeShortcut()
      api.setBrowserShortcutContext({ scopeId: scopeId.current, revision: ++revision.current, bindings: [] })
    }
  }, [store, activeTabId, tabs, view, settings, search])
  return null
}
