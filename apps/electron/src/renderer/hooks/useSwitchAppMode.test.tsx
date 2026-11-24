import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { useSwitchAppMode } from './useSwitchAppMode'
import { coreSessionNavigationPhaseAtom } from '../atoms/core-target-atoms'
import { tabsAtom, activeTabIdAtom } from '../atoms/tab-atoms'
import { agentSessionsAtom } from '../atoms/agent-atoms'
import { appWindowsAtom, windowBootstrapAtom } from '../atoms/app-windows'

test('模式切换候选在其他窗口也必须本地打开，不调用跨窗聚焦或误报 switched', async () => {
 const store=createStore()
 store.set(coreSessionNavigationPhaseAtom,'ready')
 store.set(tabsAtom,[{id:'chat',sessionId:'chat',type:'chat',title:'chat'}]);store.set(activeTabIdAtom,'chat')
 store.set(agentSessionsAtom,[{id:'agent',title:'agent',createdAt:1,updatedAt:1,agentRuntime:'pi'}])
 store.set(windowBootstrapAtom,{windowId:'own',kind:'main',isPrimary:true,initialTab:null,openWindows:[]})
 store.set(appWindowsAtom,[{windowId:'other',isPrimary:false,sessions:[{type:'agent',sessionId:'agent'}]}])
 const previous=globalThis.window
 let focused=0
 globalThis.window={electronAPI:{clearAgentCompletionState:async()=>store.get(agentSessionsAtom)[0],getAgentSessionMeta:async()=>store.get(agentSessionsAtom)[0],focusSessionWindow:async()=>{focused++;return true}}} as unknown as Window & typeof globalThis
 try {
  let switchMode!:ReturnType<typeof useSwitchAppMode>
  function Harness(){switchMode=useSwitchAppMode();return null}
  renderToStaticMarkup(<Provider store={store}><Harness /></Provider>)
  const result=await switchMode('agent')
  expect(result.switched).toBe(true)
  expect(store.get(activeTabIdAtom)).toBe('agent')
  expect(focused).toBe(0)
 } finally {globalThis.window=previous}
})
