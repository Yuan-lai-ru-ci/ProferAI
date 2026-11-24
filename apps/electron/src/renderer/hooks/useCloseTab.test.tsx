import { afterEach, expect, test } from 'bun:test'
import * as React from 'react'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { useCloseTab } from './useCloseTab'
import { tabsAtom, activeTabIdAtom, createBrowserTabId, type TabItem } from '../atoms/tab-atoms'

const previousWindow = globalThis.window
afterEach(() => { globalThis.window = previousWindow })
const owner: TabItem = { id: 'owner', sessionId: 'owner', title: 'owner', type: 'agent' }
const page = (id: string): TabItem => ({ id: createBrowserTabId('owner', id), type: 'browser', sessionId: 'owner', browserTabId: id, title: id })
const [a, b, c] = [page('a'), page('b'), page('c')] as const

function harness() {
  const store = createStore()
  const requests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  globalThis.window = { electronAPI: {
    closeAgentBrowserTab: ({ sessionId, tabId }: { sessionId: string; tabId: string }) => new Promise<null>((resolve, reject) => {
      expect(sessionId).toBe('owner')
      requests.set(tabId, { resolve: () => resolve(null), reject })
    }),
    clearAgentCompletionState: async () => ({ id: 'owner' }),
  } } as unknown as Window & typeof globalThis
  store.set(tabsAtom, [owner, a, b]); store.set(activeTabIdAtom, a.id)
  let api!: ReturnType<typeof useCloseTab>
  function Harness() { api = useCloseTab(); return null }
  renderToStaticMarkup(<Provider store={store}><Harness /></Provider>)
  return { store, api, requests, tick: () => new Promise(resolve => setTimeout(resolve, 0)) }
}

test('同一 render 发起连关；等主进程确认，不覆盖中途打开的页与焦点', async () => {
  const { store, api, requests, tick } = harness()
  api.requestClose(a.id); api.requestClose(b.id)
  expect(store.get(tabsAtom)).toEqual([owner, a, b])
  store.set(tabsAtom, [owner, a, b, c]); store.set(activeTabIdAtom, c.id)
  requests.get('b')!.resolve(); await tick()
  expect(store.get(tabsAtom)).toEqual([owner, a, c])
  requests.get('a')!.resolve(); await tick()
  expect(store.get(tabsAtom)).toEqual([owner, c]); expect(store.get(activeTabIdAtom)).toBe(c.id)
})

test('关闭 owner 连带关闭实际网页；部分失败不隐藏失败页或移除 owner', async () => {
  const { store, api, requests, tick } = harness()
  api.requestCloseMany([owner.id, b.id])
  expect([...requests.keys()]).toEqual(['a', 'b'])
  requests.get('a')!.resolve(); requests.get('b')!.reject(new Error('denied')); await tick()
  expect(store.get(tabsAtom)).toEqual([owner, b])
  api.requestClose(owner.id); requests.get('b')!.resolve(); await tick()
  expect(store.get(tabsAtom)).toEqual([])
})

test('关闭 owner 等待中打开的同会话新页不被连带隐藏', async () => {
  const { store, api, requests, tick } = harness()
  api.requestClose(owner.id)
  store.set(tabsAtom, [owner, a, b, c])
  requests.get('a')!.resolve(); requests.get('b')!.resolve(); await tick()
  expect(store.get(tabsAtom)).toEqual([owner, c])
})
