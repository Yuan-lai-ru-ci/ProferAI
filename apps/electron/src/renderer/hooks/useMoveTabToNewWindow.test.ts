import { afterEach, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { moveTabToNewWindow } from './useMoveTabToNewWindow'
import { tabsAtom, activeTabIdAtom, type TabItem } from '../atoms/tab-atoms'
import { appModeAtom } from '../atoms/app-mode'
import { coreTargetsAtom } from '../atoms/core-target-atoms'
import { agentSessionDraftsAtom } from '../atoms/agent-atoms'

const original = globalThis.window
afterEach(() => { globalThis.window = original })
const tab = (id:string,type:'chat'|'agent'):TabItem => ({id,sessionId:id,title:id,type})
function setup(items:TabItem[],active:string) {
 const store=createStore()
 store.set(tabsAtom,items);store.set(activeTabIdAtom,active);store.set(appModeAtom,'agent')
 let resolve!:(value:{ok:boolean})=>void
 const ready=new Promise<{ok:boolean}>(r=>{resolve=r})
 globalThis.window={electronAPI:{openTabInNewWindow:()=>ready}} as unknown as Window & typeof globalThis
 const sync=(item:TabItem|null)=>{if(item?.type==='chat'||item?.type==='agent')store.set(appModeAtom,item.type)}
 return {store,resolve,move:(id:string)=>moveTabToNewWindow(store,sync,id)}
}

test('active Agent 拆窗优先剩余 Agent，不跳 Chat',async()=>{
 const x=setup([tab('a','agent'),tab('c','chat'),tab('b','agent')],'a')
 const promise=x.move('a');x.resolve({ok:true});await promise
 expect(x.store.get(activeTabIdAtom)).toBe('b');expect(x.store.get(appModeAtom)).toBe('agent')
})
for(const chat of [true,false])test(`最后 Agent 拆窗保持 Agent 空态，有Chat=${chat}`,async()=>{
 const x=setup([tab('a','agent'),...(chat?[tab('c','chat')]:[])],'a')
 const promise=x.move('a');x.resolve({ok:true});await promise
 expect(x.store.get(activeTabIdAtom)).toBeNull();expect(x.store.get(appModeAtom)).toBe('agent')
})
test('非活动拆窗不变当前选择',async()=>{
 const x=setup([tab('a','agent'),tab('c','chat')],'c')
 const promise=x.move('a');x.resolve({ok:true});await promise
 expect(x.store.get(activeTabIdAtom)).toBe('c')
})
test('就绪失败保留 Tab 和草稿',async()=>{
 const x=setup([tab('a','agent')],'a');x.store.set(agentSessionDraftsAtom,new Map([['a','draft']]))
 const promise=x.move('a');x.resolve({ok:false});expect(await promise).toBe(false)
 expect(x.store.get(activeTabIdAtom)).toBe('a');expect(x.store.get(agentSessionDraftsAtom).get('a')).toBe('draft')
})
test('await 期间用户换 Tab 并编辑草稿，成功不覆盖新选择/新草稿',async()=>{
 const x=setup([tab('a','agent'),tab('c','chat')],'a');x.store.set(agentSessionDraftsAtom,new Map([['a','old']]))
 const promise=x.move('a');x.store.set(activeTabIdAtom,'c');x.store.set(agentSessionDraftsAtom,new Map([['a','new']]))
 x.resolve({ok:true});await promise
 expect(x.store.get(activeTabIdAtom)).toBe('c');expect(x.store.get(agentSessionDraftsAtom).get('a')).toBe('new')
})
test('await 期间切 Core 不摘除新 Core 同名 Tab',async()=>{
 const x=setup([tab('a','agent')],'a');const promise=x.move('a')
 x.store.set(coreTargetsAtom,{currentId:'other',generation:1,targets:[]});x.store.set(tabsAtom,[tab('a','agent')])
 x.resolve({ok:true});await promise
 expect(x.store.get(activeTabIdAtom)).toBe('a');expect(x.store.get(tabsAtom)).toHaveLength(1)
})
