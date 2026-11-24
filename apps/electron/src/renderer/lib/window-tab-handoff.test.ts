import { expect,test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { receiveHandoff,trackHandoff,retryFailedHandoffs } from './window-tab-handoff'
import { agentSessionDraftsAtom } from '../atoms/agent-atoms'
import { tabsAtom,activeTabIdAtom } from '../atoms/tab-atoms'
import { coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import type { WindowTabHandoffEvent } from '@profer/shared'
const tab={id:'a',sessionId:'a',type:'agent' as const,title:'A',draft:'old'}
const event=(status:'failed'|'committed'):WindowTabHandoffEvent=>({handoffId:'h',status,tab,sourceCore:{targetId:'local'}})
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
test('快速 commit 暂存至 track；仅清匹配旧草稿，重复幂等',()=>{
 const store=createStore();store.set(coreSessionNavigationPhaseAtom,'ready');store.set(agentSessionDraftsAtom,new Map([['a','new']]))
 receiveHandoff(store,event('committed'));trackHandoff(store,'h',tab,'local')
 receiveHandoff(store,event('committed'))
 expect(store.get(agentSessionDraftsAtom).get('a')).toBe('new')
})
test('快速 failed 不先恢复；跨 Core 暂存、切回恢复并ACK失败可重试，不抢active/新输入',async()=>{
 const store=createStore();store.set(coreSessionNavigationPhaseAtom,'ready');const old=globalThis.window;let calls=0
 globalThis.window={electronAPI:{ackWindowTabHandoff:async()=>{calls++;if(calls===1)throw new Error('retry')}}} as unknown as Window & typeof globalThis
 try{
 store.set(activeTabIdAtom,'scratch');store.set(agentSessionDraftsAtom,new Map([['a','new']]))
 receiveHandoff(store,event('failed'));expect(store.get(tabsAtom)).toHaveLength(0)
 store.set(coreTargetsAtom,{currentId:'other',generation:1,targets:[]})
 trackHandoff(store,'h',tab,'local');expect(store.get(tabsAtom)).toHaveLength(0)
 store.set(coreTargetsAtom,{currentId:'local',generation:2,targets:[{id:'local',name:'local',kind:'local',status:'connected'}]})
 retryFailedHandoffs(store);await settle();expect(calls).toBe(1)
 retryFailedHandoffs(store);await settle();expect(calls).toBe(2)
 expect(store.get(activeTabIdAtom)).toBe('scratch');expect(store.get(agentSessionDraftsAtom).get('a')).toBe('new')
 expect(store.get(tabsAtom).filter(t=>t.id==='a')).toHaveLength(1)
 receiveHandoff(store,event('failed'),true);await settle();expect(calls).toBe(2)
 }finally{globalThis.window=old}
})
test('无来源hook的recoverable记录可以后台恢复并ACK',async()=>{
 const store=createStore();store.set(coreSessionNavigationPhaseAtom,'ready');const old=globalThis.window;let ack=0
 globalThis.window={electronAPI:{ackWindowTabHandoff:async()=>{ack++}}} as unknown as Window & typeof globalThis
 try{receiveHandoff(store,event('failed'),true);await settle();expect(ack).toBe(1);expect(store.get(agentSessionDraftsAtom).get('a')).toBe('old')}
 finally{globalThis.window=old}
})
