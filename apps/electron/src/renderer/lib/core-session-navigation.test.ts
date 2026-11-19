import { afterEach, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import type { AppSettings, CoreTargetsSnapshot, CoreTabSettings } from '../../types/settings'
import { activeTabIdAtom, tabsAtom } from '../atoms/tab-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '../atoms/agent-atoms'
import { coreTargetsAtom } from '../atoms/core-target-atoms'
import { initializeCoreSessionNavigation } from './core-session-navigation'

const remoteId = 'core:linux:remote-session'
const workspace = (id: string): AgentWorkspace => ({ id, name:id, slug:id, type:'personal', createdAt:1, updatedAt:1 })
const session = (id:string, workspaceId:string): AgentSessionMeta => ({ id, title:id, workspaceId, createdAt:1,updatedAt:1,agentRuntime:'pi' })
const localSession = session('local-session','local-ws')
const remoteSession = session(remoteId,'linux-ws')
function snapshot(id:string,generation:number): CoreTargetsSnapshot {
  return { currentId:id,generation,targets:[{id:'local',name:'本机',kind:'local',status:'connected'},
    {id:'linux-target',name:'Linux',kind:'remote',status:'connected',coreId:'linux'}] }
}
const state = (item:AgentSessionMeta): CoreTabSettings => ({tabs:[{id:item.id,sessionId:item.id,type:'agent',title:item.title}],activeTabId:item.id,workspaceId:item.workspaceId})
const cleanups:(()=>void)[]=[]
afterEach(()=>cleanups.splice(0).forEach(f=>f()))
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
function setup(saved:Partial<AppSettings>={}, options:{deferRemote?:boolean;failRemote?:boolean}={}) {
 const store=createStore()
 store.set(coreTargetsAtom,snapshot('local',0))
 let resolveRemote!:(items:AgentSessionMeta[])=>void
 const remotePromise=new Promise<AgentSessionMeta[]>(resolve=>{resolveRemote=resolve})
 const writes:Partial<AppSettings>[]=[]
 const failures:unknown[]=[]
 const navigation=initializeCoreSessionNavigation(store,{
  getSettings:async()=>({themeMode:'system',...saved}),listCoreTargets:async()=>snapshot('local',0),
  listConversations:async()=>[],
  listAgentSessions:async()=>{
   if(store.get(coreTargetsAtom).currentId==='local')return [localSession]
   if(options.failRemote)throw new Error('remote catalog unavailable')
   return options.deferRemote?remotePromise:[remoteSession]
  },
  listWorkspaces:async()=>[workspace(store.get(coreTargetsAtom).currentId==='local'?'local-ws':'linux-ws')],
  updateSettings:async patch=>{writes.push(structuredClone(patch));return {}},
  onFailure:error=>failures.push(error),
 })
 cleanups.push(navigation.dispose)
 return {store,navigation,writes,failures,resolveRemote}
}
test('Given 两个Core各有历史 When 往返切换 Then 同步卸载来源Tab并恢复目标会话/工作区',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':state(remoteSession)}})
 await x.navigation.ready
 expect(x.store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
 x.store.set(coreTargetsAtom,snapshot('linux-target',1))
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.store.get(tabsAtom).some(t=>t.sessionId===localSession.id)).toBe(false)
 await settle()
 expect(x.store.get(activeTabIdAtom)).toBe(remoteId)
 expect(x.store.get(currentAgentWorkspaceIdAtom)).toBe('linux-ws')
 x.store.set(coreTargetsAtom,snapshot('local',2));await settle()
 expect(x.store.get(activeTabIdAtom)).toBe(localSession.id)
 await x.navigation.flush()
 expect(x.writes.at(-1)?.coreTabStates?.['core:linux']?.activeTabId).toBe(remoteId)
})
test('Given 目标从未打开或记忆会话被删除 When 切入 Then 不保留来源或随意打开其他会话',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':state(session('core:linux:deleted','linux-ws'))}})
 await x.navigation.ready;x.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.store.get(tabsAtom).filter(t=>t.type==='agent')).toEqual([])
})
test('Given B目录加载延迟 When 已切回A Then B迟到响应不能覆盖A',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':state(remoteSession)}},{deferRemote:true})
 await x.navigation.ready
 x.store.set(coreTargetsAtom,snapshot('linux-target',1));x.store.set(coreTargetsAtom,snapshot('local',2));await settle()
 x.resolveRemote([remoteSession]);await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
 expect(x.store.get(agentSessionsAtom).map(s=>s.id)).toEqual([localSession.id])
})
test('Given 目标加载失败 When 空态/退出触发保存 Then 不覆盖目标历史记忆',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':state(remoteSession)}},{failRemote:true})
 await x.navigation.ready;x.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle();await x.navigation.flush()
 expect(x.failures).toHaveLength(1)
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.writes.at(-1)?.coreTabStates?.['core:linux']?.activeTabId).toBe(remoteId)
})
test('Given 旧全局tabState When 启动 Then 只迁移当前Core目录中有效会话',async()=>{
 const legacy={tabs:[...state(localSession).tabs,...state(remoteSession).tabs],activeTabId:localSession.id}
 const x=setup({tabState:legacy});await x.navigation.ready
 expect(x.store.get(activeTabIdAtom)).toBe(localSession.id)
 x.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
})
test('Given 同Core状态广播 When generation不变 Then 不清空用户新选会话',async()=>{
 const x=setup({coreTabStates:{local:state(localSession)}});await x.navigation.ready
 x.store.set(coreTargetsAtom,snapshot('local',0));await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
})

test('Given 无历史的新Core When 首次切入 Then 空态不创建或借用会话',async()=>{
 const x=setup({coreTabStates:{local:state(localSession)}});await x.navigation.ready
 x.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.store.get(tabsAtom).some(t=>t.type==='agent')).toBe(false)
})
test('Given 本Core记忆指向另一Core会话 When 目录混入同记录 Then 不能恢复串目标会话',async()=>{
 const x=setup({coreTabStates:{local:state(remoteSession)}});await x.navigation.ready
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.store.get(tabsAtom).some(t=>t.sessionId===remoteId)).toBe(false)
})
test('Given 本轮写入按Core历史 When 刷新初始化 Then 仍恢复最后访问会话',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':state(remoteSession)}})
 await x.navigation.ready;x.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
 x.store.set(coreTargetsAtom,snapshot('local',2));await settle();await x.navigation.flush()
 const y=setup(x.writes.at(-1));await y.navigation.ready
 expect(y.store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
 y.store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
 expect(y.store.get(currentAgentSessionIdAtom)).toBe(remoteId)
})
test('Given 记忆中的活动会话不存在但其他标签有效 When 加载并保存 Then 不偷偷选其他标签',async()=>{
 const x=setup({coreTabStates:{local:{...state(localSession),activeTabId:'deleted'}}})
 await x.navigation.ready;await x.navigation.flush()
 expect(x.store.get(currentAgentSessionIdAtom)).toBeNull()
 expect(x.writes.at(-1)?.coreTabStates?.local?.activeTabId).toBeNull()
})

test('Given 初始化目录迟到 When 用户已点击新会话 Then 用户选择优先于旧记忆',async()=>{
 const x=setup({coreTabStates:{local:state(localSession),'core:linux':{tabs:[],activeTabId:null}}},{deferRemote:true})
 await x.navigation.ready;x.store.set(coreTargetsAtom,snapshot('linux-target',1))
 x.store.set(tabsAtom,state(remoteSession).tabs)
 x.store.set(activeTabIdAtom,remoteId)
 x.store.set(currentAgentSessionIdAtom,remoteId)
 x.resolveRemote([remoteSession]);await settle()
 expect(x.store.get(currentAgentSessionIdAtom)).toBe(remoteId)
})
test('Given 当前为草稿页 When 切走和刷新 Then 恢复草稿而不是最后业务会话',async()=>{
 const x=setup({coreTabStates:{local:{...state(localSession),activeTabId:'__scratch-pad__'}}});await x.navigation.ready
 expect(x.store.get(activeTabIdAtom)).toBe('__scratch-pad__')
 await x.navigation.flush();const y=setup(x.writes.at(-1));await y.navigation.ready
 expect(y.store.get(activeTabIdAtom)).toBe('__scratch-pad__')
 expect(y.store.get(currentAgentSessionIdAtom)).toBeNull()
})
