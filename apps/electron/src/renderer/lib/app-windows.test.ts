import { appWindowsAtom, windowBootstrapAtom, windowSessionKeysAtom } from '../atoms/app-windows'
import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { focusSessionOrOpenLocal, applyInitialWindowTab, collectWindowSessions, hasOtherSessionWindow } from './app-windows'
import { SCRATCH_PAD_ID, ensureScratchPadTab, activeTabIdAtom, tabsAtom } from '../atoms/tab-atoms'
import { agentSessionDraftsAtom, agentSessionDraftHtmlAtom } from '../atoms/agent-atoms'
import { conversationDraftsAtom } from '../atoms/chat-atoms'
import { resolveSessionLeadingMarkers, limitSessionLeadingMarkers } from '../components/app-shell/left-sidebar/sidebar-utils'

test('主角色接任跟随实时快照，保持窗口ID和所有Tab草稿；迟到bootstrap不退回旧角色', () => {
 const store=createStore()
 const bootstrap={windowId:'successor',kind:'session' as const,isPrimary:false,initialTab:{id:'a',sessionId:'a',type:'agent' as const,title:'A',draft:'keep'},openWindows:[]}
 store.set(windowBootstrapAtom,bootstrap)
 applyInitialWindowTab(store,bootstrap.initialTab)
 store.set(appWindowsAtom,[{windowId:'successor',isPrimary:true,sessions:[{type:'agent',sessionId:'a'}]}])
 expect(store.get(windowBootstrapAtom)).toMatchObject({windowId:'successor',isPrimary:true,kind:'main'})
 expect(store.get(windowSessionKeysAtom).has('agent:a')).toBe(false)
 expect(store.get(activeTabIdAtom)).toBe('a')
 expect(store.get(agentSessionDraftsAtom).get('a')).toBe('keep')
 store.set(windowBootstrapAtom,bootstrap)
 expect(store.get(windowBootstrapAtom)?.isPrimary).toBe(true)
 expect(bootstrap.isPrimary).toBe(false)
})

test('目录恢复后交接 Agent initialTab 同时保留纯文本与引用富文本草稿', () => {
  const store = createStore()
  applyInitialWindowTab(store, { id: 'a', sessionId: 'a', type: 'agent', title: 'Agent', draft: 'quote', draftHtml: '<p>quote</p>' })
  expect(store.get(activeTabIdAtom)).toBe('a')
  expect(store.get(agentSessionDraftsAtom).get('a')).toBe('quote')
  expect(store.get(agentSessionDraftHtmlAtom).get('a')).toBe('<p>quote</p>')
  expect(collectWindowSessions(store.get(tabsAtom))).toEqual([{type:'agent',sessionId:'a'}])
})

test('Chat initialTab 恢复草稿且空引导不覆盖已有 Tab', () => {
  const store = createStore()
  applyInitialWindowTab(store, { id:'c',sessionId:'c',type:'chat',title:'Chat',draft:'hello' })
  applyInitialWindowTab(store, null)
  expect(store.get(activeTabIdAtom)).toBe('c')
  expect(store.get(conversationDraftsAtom).get('c')).toBe('hello')
})

test('聚焦路由仅匹配其他次级窗口，不拦截自身及 primary', () => {
  const session = {type:'agent' as const,sessionId:'a'}
  const windows = [{windowId:'own',isPrimary:false,sessions:[session]},{windowId:'primary',isPrimary:true,sessions:[session]}]
  expect(hasOtherSessionWindow(windows,'own',session)).toBe(false)
  expect(hasOtherSessionWindow([...windows,{windowId:'other',isPrimary:false,sessions:[session]}],'own',session)).toBe(true)
  expect(hasOtherSessionWindow(windows,'own',{type:'chat',sessionId:'a'})).toBe(false)
  expect(hasOtherSessionWindow([], 'own', session)).toBe(false)
})

test('窗口标记位于置顶和 Goal 之间并参与三枚容量折叠', () => {
  const markers = resolveSessionLeadingMarkers({pinnable:true,pinned:true,showPinIcon:true,inWindow:true,goalStatus:'active',hasBrowser:true,regeneratingTitle:false})
  expect(markers).toEqual(['pin','window','goal','browser'])
  expect(limitSessionLeadingMarkers(markers)).toEqual({visible:['pin','window','goal'],overflow:['browser']})
})

test('聚焦成功不创建本地 Tab，目标关闭或 IPC 失败均本地回退', async () => {
 let opened = 0
 const local = () => { opened += 1 }
 await focusSessionOrOpenLocal(async () => true, local)
 expect(opened).toBe(0)
 await focusSessionOrOpenLocal(async () => false, local)
 expect(opened).toBe(1)
 await focusSessionOrOpenLocal(async () => { throw new Error('closed') }, local)
 expect(opened).toBe(2)
})

test('后台交接创建承载 Tab 和草稿，不抢活动选择', () => {
 const store=createStore()
 applyInitialWindowTab(store,{id:'c',sessionId:'c',type:'chat',title:'chat'})
 applyInitialWindowTab(store,{id:'a',sessionId:'a',type:'agent',title:'agent',draft:'text',draftHtml:'<p>text</p>'},false)
 expect(store.get(activeTabIdAtom)).toBe('c')
 expect(store.get(tabsAtom).some(tab=>tab.id==='a')).toBe(true)
 expect(store.get(agentSessionDraftsAtom).get('a')).toBe('text')
 expect(store.get(agentSessionDraftHtmlAtom).get('a')).toBe('<p>text</p>')
})

test('点击 Scratch 后迟到 Chat initialTab 只后台承载，不替换草稿页', () => {
 const store=createStore()
 applyInitialWindowTab(store,{id:'a',sessionId:'a',type:'agent',title:'agent'})
 store.set(tabsAtom,ensureScratchPadTab(store.get(tabsAtom)))
 store.set(activeTabIdAtom,SCRATCH_PAD_ID)
 applyInitialWindowTab(store,{id:'c',sessionId:'c',type:'chat',title:'chat',draft:'late'},false)
 expect(store.get(activeTabIdAtom)).toBe(SCRATCH_PAD_ID)
 expect(store.get(tabsAtom).some(tab=>tab.id==='c')).toBe(true)
 expect(store.get(conversationDraftsAtom).get('c')).toBe('late')
})
