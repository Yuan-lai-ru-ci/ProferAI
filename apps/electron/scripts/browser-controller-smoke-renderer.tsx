import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider, createStore, useStore } from 'jotai'
import type { BrowserViewState } from '@profer/shared'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { tabsAtom, activeTabIdAtom, type TabItem } from '../src/renderer/atoms/tab-atoms'
import { activeViewAtom } from '../src/renderer/atoms/active-view'
import { settingsOpenAtom } from '../src/renderer/atoms/settings-tab'
import { searchDialogOpenAtom } from '../src/renderer/atoms/search-atoms'
import { initShortcutRegistry } from '../src/renderer/lib/shortcut-registry'
import { BrowserGuestHost, browserGuestSlotId } from '../src/renderer/components/browser/BrowserGuestHost'
import { BrowserPanel } from '../src/renderer/components/browser/BrowserPanel'
import { BrowserShortcutBridge } from '../src/renderer/components/browser/BrowserShortcutBridge'
import { browserPageState } from '../src/renderer/components/browser/BrowserTabContent'
import { SplitViewCloseButton } from '../src/renderer/components/tabs/SplitViewCloseButton'

initShortcutRegistry()
const store = createStore()
type FixtureOptions = { panels?: boolean; scale?: number; dark?: boolean; errorTab?: string }
const root = document.getElementById('root')
if (!root) throw new Error('缺少 fixture root')

function BrowserAtomSync({ state, pages }: { state: BrowserViewState | null; pages: string[] }): null {
  const atomStore = useStore()
  React.useEffect(() => {
    const tabIds = state?.tabs.map(page => page.tabId) ?? pages
    const tabs: TabItem[] = tabIds.map(tabId => ({ id: `browser:${tabId}`, type: 'browser', sessionId: 's1', title: tabId, browserTabId: tabId }))
    atomStore.set(tabsAtom, tabs)
    atomStore.set(activeTabIdAtom, state?.activeTabId ? `browser:${state.activeTabId}` : tabs[0]?.id ?? null)
    atomStore.set(activeViewAtom, 'conversations')
    atomStore.set(settingsOpenAtom, false)
    atomStore.set(searchDialogOpenAtom, false)
  }, [atomStore, state, pages])
  return null
}

function Fixture(): React.ReactElement {
  const [pages, setPages] = React.useState<string[]>([])
  const [state, setState] = React.useState<BrowserViewState | null>(null)
  const [options, setOptions] = React.useState<FixtureOptions>({})
  const [focused, setFocused] = React.useState('')
  React.useEffect(() => {
    const update = (event: Event): void => { setPages((event as CustomEvent<string[]>).detail) }
    const configure = (event: Event): void => { setOptions(previous => ({ ...previous, ...(event as CustomEvent<FixtureOptions>).detail })) }
    window.addEventListener('smoke-pages', update)
    window.addEventListener('smoke-options', configure)
    const unsubscribe = window.electronAPI.onAgentBrowserStateChanged(next => setState(next))
    const unsubscribeFocus = window.electronAPI.onBrowserGuestFocused(({ tabId }) => setFocused(tabId))
    return () => {
      window.removeEventListener('smoke-pages', update)
      window.removeEventListener('smoke-options', configure)
      unsubscribe(); unsubscribeFocus()
    }
  }, [])
  React.useLayoutEffect(() => { document.documentElement.classList.toggle('dark', options.dark === true) }, [options.dark])
  const scale = options.scale ?? 1
  return <Provider store={store}><TooltipProvider delayDuration={100}>
    <BrowserAtomSync state={state} pages={pages} />
    <BrowserShortcutBridge />
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#f5f5f5' }}>
      <div id="fixture-host" className="bg-content-area text-foreground" style={options.panels
        ? { position: 'absolute', left: 140, top: 90, width: 720, height: 540, transform: `scale(${scale})`, transformOrigin: 'top left', borderRadius: 20 }
        : { position: 'relative', width: '100%', height: '100%' }}>
        <div id="fixture-panes" style={{ position: 'absolute', top: options.panels ? 0 : 80, left: options.panels ? 0 : 80, right: options.panels ? 0 : 80, bottom: options.panels ? 0 : 80, display: 'flex', gap: 20, borderRadius: 20, overflow: 'hidden' }}>
          {pages.map(tabId => options.panels
            ? <section key={tabId} data-fixture-panel={tabId} style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', borderRadius: 20 }}>
                <BrowserPanel sessionId="s1" state={options.errorTab === tabId && state
                  ? { ...browserPageState(state, tabId)!, loading: false, loadError: '模拟主框架加载失败，请重试' }
                  : browserPageState(state, tabId)} visible active={state?.activeTabId === tabId} onClose={() => setPages(previous => previous.filter(page => page !== tabId))} />
              </section>
            : <div key={tabId} id={browserGuestSlotId('s1', tabId)} data-browser-guest-slot data-browser-guest-visible="true" style={{ flex: 1, height: '100%', borderRadius: 20 }} />)}
          {options.panels && pages.length > 1 && <SplitViewCloseButton onClose={() => setPages(previous => previous.slice(0, 1))} />}
        </div>
        <BrowserGuestHost />
      </div>
      {!options.panels && <button id="overlay" style={{ position: 'fixed', zIndex: 10, left: 100, top: 120, width: 130, height: 50 }}>宿主 DOM 遮罩</button>}
      <button id="outside" style={{ position: 'fixed', zIndex: 10, left: 20, top: 20 }} onClick={event => { event.currentTarget.dataset.clicked = 'true' }}>网页区域外按钮</button>
      <output id="fixture-focused" data-tab-id={focused} />
    </div>
  </TooltipProvider></Provider>
}
createRoot(root).render(<React.StrictMode><Fixture /></React.StrictMode>)
