import {expect,test} from 'bun:test'
import {createStore} from 'jotai/vanilla'
import {agentWindowListenersReadyAtom,confirmHandoffWhenReady} from './confirm-window-handoff'
import type {MainWindowBootstrap} from '@profer/shared'
const bootstrap:MainWindowBootstrap={windowId:'w',kind:'main',isPrimary:false,initialTab:{id:'a',type:'agent',sessionId:'a',title:'a'},handoffId:'h',openWindows:[]}
test('生产确认helper等待listener ready，report先于confirm，关闭取消迟到确认',async()=>{
 const old=globalThis.window
 try{
  for(const abort of [false,true]){
   const calls:string[]=[];const store=createStore();const controller=new AbortController()
   globalThis.window={electronAPI:{reportWindowSessions:async()=>{calls.push('report')},confirmWindowBootstrap:async()=>{calls.push('confirm')}}} as unknown as Window & typeof globalThis
   const work=confirmHandoffWhenReady(store,bootstrap,controller.signal)
   await Promise.resolve();expect(calls).toEqual([])
   if(abort)controller.abort()
   store.set(agentWindowListenersReadyAtom,true)
   await work
   expect(calls).toEqual(abort?[]:['report','confirm'])
  }
 }finally{globalThis.window=old}
})
