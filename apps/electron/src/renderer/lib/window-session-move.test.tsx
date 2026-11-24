import { afterEach, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AppWindowSession, MainWindowTabPayload, WindowMoveResult } from '@profer/shared'
import { appWindowsAtom, windowBootstrapAtom, windowSessionKeysAtom } from '../atoms/app-windows'
import { activeTabIdAtom, tabsAtom } from '../atoms/tab-atoms'
import { coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom } from '../atoms/agent-atoms'
import { activeViewAtom } from '../atoms/active-view'
import { conversationDraftsAtom } from '../atoms/chat-atoms'
import { useOpenSession } from '../hooks/useOpenSession'
import { moveTabToNewWindow } from '../hooks/useMoveTabToNewWindow'
import { receiveHandoff } from './window-tab-handoff'
import { openExplorationBranchTab } from './exploration-tab'
import { prepareWindowSessionMove } from './window-session-move'
import { acceptWindowSessionMove, applyInitialWindowTab, releaseWindowSessionMove, requestSessionMoveHere } from './app-windows'
import { agentWindowListenersReadyAtom } from './confirm-window-handoff'

const oldWindow = globalThis.window
afterEach(() => { globalThis.window = oldWindow })
const core = { targetId: 'local', generation: 0 }
const parent: MainWindowTabPayload = { id: 'p', sessionId: 'p', title: '父', type: 'agent' }
const child: MainWindowTabPayload = { id: 'c', sessionId: 'c', title: '子', type: 'agent', parentSessionId: 'p', draft: '草稿', draftHtml: '<p>草稿</p>' }
const sync = () => {}
function ready(id: string, primary: boolean) {
  const store = createStore()
  store.set(coreSessionNavigationPhaseAtom, 'ready')
  store.set(agentWindowListenersReadyAtom, true)
  store.set(windowBootstrapAtom, { windowId: id, isPrimary: primary, kind: 'main', openWindows: [], initialTab: null })
  return store
}
function setApi(api: object) { globalThis.window = { electronAPI: api } as unknown as Window & typeof globalThis }

for (const isPrimary of [true, false]) test(`真实导航：${isPrimary ? '主' : '次'}窗口点已分窗的探索/委派子会话，前往其 owner 而非复制或切走父会话`, async () => {
  const store = ready('own', isPrimary)
  applyInitialWindowTab(store, parent)
  store.set(appWindowsAtom, [{ windowId: 'other', isPrimary: !isPrimary, sessions: [child] }])
  store.set(activeViewAtom, 'planning')
  const calls: AppWindowSession[] = []
  setApi({ focusSessionWindow: async (session: AppWindowSession) => { calls.push(session); return true } })
  let open!: ReturnType<typeof useOpenSession>
  function Entry() { open = useOpenSession(); return null }
  renderToStaticMarkup(<Provider store={store}><Entry /></Provider>)
  open('agent', child.sessionId, child.title, parent.sessionId)
  openExplorationBranchTab(store, parent.sessionId, child, { autoGroup: true })
  await Promise.resolve()
  expect(calls).toEqual([{ type: 'agent', sessionId: 'c' }, { type: 'agent', sessionId: 'c' }])
  expect(store.get(windowSessionKeysAtom).has('agent:c')).toBe(true)
  expect(store.get(activeTabIdAtom)).toBe('p')
  expect(store.get(tabsAtom).some(tab => tab.id === 'c')).toBe(false)
  expect(store.get(activeViewAtom)).toBe('planning')
  setApi({ focusSessionWindow: async () => false })
  openExplorationBranchTab(store, 'p', child)
  await Promise.resolve(); await Promise.resolve()
  expect(store.get(tabsAtom).find(item => item.id === 'c')?.parentSessionId).toBe('p')
})

test('真实移入请求：单移子项保留父、血缘和两种草稿；目标确认前源仍在，重复提交不删重开的标签', async () => {
  const source = ready('s', true), destination = ready('d', false)
  applyInitialWindowTab(source, parent); applyInitialWindowTab(source, child)
  expect(prepareWindowSessionMove(source, { handoffId: 'p', session: parent, core })).toEqual({tab: parent})
  setApi({ reportWindowSessions: async () => {}, moveSessionToThisWindow: async (session: AppWindowSession) => {
    const prepared = prepareWindowSessionMove(source, { handoffId: 'h', session, core })
    if (!('tab' in prepared)) throw new Error(prepared.error)
    const { tab } = prepared
    expect(await acceptWindowSessionMove(destination, { handoffId: 'h', tab, core })).toEqual({ ok: true })
    expect(source.get(tabsAtom).some(item => item.id === 'c')).toBe(true)
    const event = { handoffId: 'h', sourceCore: core, sourceGeneration: 0, existingWindowMove: true as const, status: 'committed' as const, tab }
    releaseWindowSessionMove(source, event, sync)
    expect(source.get(agentSessionDraftHtmlAtom).has('c')).toBe(false)
    expect(source.get(tabsAtom).map(item => item.id)).not.toContain('c')
    expect(source.get(tabsAtom).map(item => item.id)).toContain('p')
    // 子项在另窗时，允许只移父项，无子树负载。
    expect(prepareWindowSessionMove(source, { handoffId: 'p2', session: parent, core })).toEqual({tab: parent})
    applyInitialWindowTab(source, child); releaseWindowSessionMove(source, event, sync)
    expect(source.get(tabsAtom).map(item => item.id)).toContain('c')
    return { ok: true }
  } })
  expect(await requestSessionMoveHere(destination, child, sync)).toEqual({ok:true})
  expect(destination.get(tabsAtom).find(item => item.id === 'c')).toMatchObject({parentSessionId:'p'})
  expect(destination.get(tabsAtom).some(item => item.id === 'p')).toBe(false)
  expect(destination.get(agentSessionDraftsAtom).get('c')).toBe('草稿')
  expect(destination.get(agentSessionDraftHtmlAtom).get('c')).toBe('<p>草稿</p>')
})

test('确认拒绝或源在确认期间编辑：不丢源草稿，目标也不覆盖/清除已有输入',async()=>{
  const source = ready('s', false), destination = ready('d', true)
  const chat: MainWindowTabPayload = {id:'chat', type:'chat', sessionId:'chat', title:'Chat', draft:'old'}
  applyInitialWindowTab(source, chat)
  destination.set(conversationDraftsAtom, new Map([['chat','local']]))
  const before = {id:'before', type:'chat' as const, sessionId:'before', title:'Before'}
  applyInitialWindowTab(destination, before)
  let count = 0
  setApi({ reportWindowSessions: async () => {}, moveSessionToThisWindow: async ():Promise<WindowMoveResult> => {
    const handoffId = `move-${++count}`
    const snapshot = prepareWindowSessionMove(source, {handoffId, session:chat, core})
    if (!('tab' in snapshot)) throw new Error(snapshot.error)
    const result = await acceptWindowSessionMove(destination, {handoffId, tab:snapshot.tab, core})
    if (!result.ok) return result
    source.set(conversationDraftsAtom, new Map([['chat','new input']]))
    releaseWindowSessionMove(source, {handoffId, status:'committed', tab:snapshot.tab, sourceCore:core, sourceGeneration:0}, sync)
    return {ok:false,error:'源标签仍在'}
  }})
  expect((await requestSessionMoveHere(destination, chat, sync)).ok).toBe(false)
  expect(destination.get(conversationDraftsAtom).get('chat')).toBe('local')
  destination.set(conversationDraftsAtom,new Map([['chat','old']]))
  expect((await requestSessionMoveHere(destination, chat, sync)).ok).toBe(false)
  expect(destination.get(tabsAtom).some(item=>item.id==='chat')).toBe(false)
  expect(destination.get(activeTabIdAtom)).toBe('before')
  expect(destination.get(conversationDraftsAtom).get('chat')).toBe('old')
  expect(source.get(tabsAtom).some(item=>item.id==='chat')).toBe(true)
  expect(source.get(conversationDraftsAtom).get('chat')).toBe('new input')
})

test('拆到新窗口：accepted 不等于 commit；失败保留原位，确认后只摘这一个标签', async()=>{
  const store = ready('s',true)
  applyInitialWindowTab(store,child)
  let id = 'first'
  setApi({openTabInNewWindow:async()=>({ok:true,accepted:true,handoffId:id}), ackWindowTabHandoff:async()=>{}})
  expect(await moveTabToNewWindow(store,sync,'c')).toBe(true)
  expect(store.get(activeTabIdAtom)).toBe('c')
  receiveHandoff(store,{handoffId:id,status:'failed',tab:child,sourceCore:core})
  expect(store.get(agentSessionDraftHtmlAtom).get('c')).toBe(child.draftHtml!)
  id='next'; await moveTabToNewWindow(store,sync,'c')
  receiveHandoff(store,{handoffId:id,status:'committed',tab:child,sourceCore:core})
  expect(store.get(tabsAtom).some(item=>item.id==='c')).toBe(false)
})

test('代际改变后源端 prepare 拒绝，未经请求的 accept 拒绝', async()=>{
  const store=ready('own',false); applyInitialWindowTab(store,child)
  store.set(coreTargetsAtom,{...store.get(coreTargetsAtom),generation:1})
  expect(prepareWindowSessionMove(store,{handoffId:'h',session:child,core})).toHaveProperty('error')
  expect((await acceptWindowSessionMove(store,{handoffId:'h',tab:parent,core})).ok).toBe(false)
})
