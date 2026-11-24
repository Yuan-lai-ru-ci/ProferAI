import { afterEach, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta, AgentWorkspace } from '@profer/shared'
import type { AppSettings, CoreTargetsSnapshot, CoreTabSettings } from '../../types/settings'
import { activeTabIdAtom, ensureScratchPadTab, tabsAtom } from '../atoms/tab-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '../atoms/agent-atoms'
import { conversationsAtom, currentConversationIdAtom } from '../atoms/chat-atoms'
import { mergeWindowCoreSnapshot, coreSessionNavigationPhaseAtom, coreTargetsAtom } from '../atoms/core-target-atoms'
import { applyInitialWindowTab } from './app-windows'
import { appWindowsAtom, windowBootstrapAtom } from '../atoms/app-windows'
import { agentSessionDraftsAtom } from '../atoms/agent-atoms'
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
function setup(saved:Partial<AppSettings>={}, options:{deferRemote?:boolean;failRemote?:boolean;failLocal?:boolean;isolated?:boolean}={}) {
 const store=createStore()
 store.set(coreTargetsAtom,snapshot('local',0))
 let resolveRemote!:(items:AgentSessionMeta[])=>void
 const remotePromise=new Promise<AgentSessionMeta[]>(resolve=>{resolveRemote=resolve})
 const writes:Partial<AppSettings>[]=[]
 const failures:unknown[]=[]
 let failLocal = Boolean(options.failLocal)
 const navigation=initializeCoreSessionNavigation(store,{
  isolated: options.isolated,
  getSettings:async()=>({themeMode:'system',...saved}),listCoreTargets:async()=>snapshot('local',0),
  listConversations:async()=>[],
  listAgentSessions:async()=>{
   if(store.get(coreTargetsAtom).currentId==='local') {
    if(failLocal)throw new Error('local catalog unavailable')
    return [localSession]
   }
   if(options.failRemote)throw new Error('remote catalog unavailable')
   return options.deferRemote?remotePromise:[remoteSession]
  },
  listWorkspaces:async()=>[workspace(store.get(coreTargetsAtom).currentId==='local'?'local-ws':'linux-ws')],
  updateSettings:async patch=>{writes.push(structuredClone(patch));return {}},
  onFailure:error=>failures.push(error),
 })
 cleanups.push(navigation.dispose)
 return {store,navigation,writes,failures,resolveRemote,setFailLocal:(value:boolean)=>{failLocal=value}}
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
test('Given 本机 Core 慢启动 When 就绪并初始化 Scratch Pad Then 恢复原会话', async () => {
 const store = createStore()
 const initial = snapshot('local', 0)
 initial.startup = 'restoring'
 initial.targets[0]!.status = 'disconnected'
 const reads: string[] = []
 const failures: unknown[] = []
 const navigation = initializeCoreSessionNavigation(store, {
  getSettings: async () => ({themeMode:'system', coreTabStates:{local:state(localSession)}}),
  listCoreTargets: async () => initial,
  listAgentSessions: async () => {
   reads.push('sessions')
   store.set(tabsAtom, ensureScratchPadTab(store.get(tabsAtom)))
   return [localSession]
  },
  listConversations: async () => { reads.push('chat'); return [] },
  listWorkspaces: async () => { reads.push('workspaces'); return [workspace('local-ws')] },
  updateSettings: async () => ({}), onFailure: error => failures.push(error),
 })
 cleanups.push(navigation.dispose)
 await settle()
 expect(reads).toEqual([])
 expect(store.get(coreSessionNavigationPhaseAtom)).toBe('loading')
 store.set(coreTargetsAtom, {...snapshot('local', 0), revision: 1})
 await settle()
 expect(reads).toEqual(['sessions', 'chat', 'workspaces'])
 expect(failures).toEqual([])
 expect(store.get(coreSessionNavigationPhaseAtom)).toBe('ready')
 expect(store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
})

test('Given 会话加载失败 When 同Core就绪状态更新 Then 重试恢复原会话', async () => {
 const x = setup({coreTabStates:{local:state(localSession)}}, {failLocal:true})
 x.store.set(coreTargetsAtom,{...snapshot('local',0),revision:1,targets:[{id:'local',name:'本机',kind:'local',status:'error'}]})
 await x.navigation.ready
 expect(x.store.get(coreSessionNavigationPhaseAtom)).toBe('error')
 x.setFailLocal(false)
 x.store.set(coreTargetsAtom,{...snapshot('local',0),revision:2})
 await settle()
 expect(x.store.get(coreSessionNavigationPhaseAtom)).toBe('ready')
 expect(x.store.get(currentAgentSessionIdAtom)).toBe(localSession.id)
 expect(x.failures).toHaveLength(1)
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

test('Given Linux Chat历史 When 切换Core并返回 Then 按Core恢复列表Tab及当前对话且兼容本机裸ID', async () => {
 const store = createStore()
 store.set(coreTargetsAtom, snapshot('local', 0))
 const chatState = (id: string): CoreTabSettings => ({ tabs: [{ id, sessionId:id, title:id, type:'chat' }], activeTabId:id })
 const navigation = initializeCoreSessionNavigation(store, {
  getSettings:async()=>({ themeMode:'system', coreTabStates:{ local:chatState('old-local'), 'core:linux':chatState('core-chat:linux:chat') } }),
  listCoreTargets:async()=>snapshot('local',0),
  listConversations:async()=>[{ id:store.get(coreTargetsAtom).currentId === 'local' ? 'old-local' : 'core-chat:linux:chat', title:'Chat', createdAt:1, updatedAt:1 }],
  listAgentSessions:async()=>[], listWorkspaces:async()=>[], updateSettings:async()=>({}), onFailure:error=>{ throw error },
 })
 cleanups.push(navigation.dispose)
 await navigation.ready
 expect(store.get(currentConversationIdAtom)).toBe('old-local')
 store.set(coreTargetsAtom,snapshot('linux-target',1))
 expect(store.get(currentConversationIdAtom)).toBeNull()
 await settle()
 expect(store.get(currentConversationIdAtom)).toBe('core-chat:linux:chat')
 expect(store.get(conversationsAtom).map(item=>item.id)).toEqual(['core-chat:linux:chat'])
 store.set(coreTargetsAtom,snapshot('local',2));await settle()
 expect(store.get(currentConversationIdAtom)).toBe('old-local')
})

test('Given 旧本机裸ID历史 When 本机Core返回同rawId Then 迁移Tab和活动对话不丢历史', async () => {
 const store=createStore()
 const target:CoreTargetsSnapshot={currentId:'local',generation:1,targets:[{id:'local',name:'本机Core',kind:'local',status:'connected',coreId:'machine',capabilities:['chat']}]}
 store.set(coreTargetsAtom,target)
 const navigation=initializeCoreSessionNavigation(store,{
  getSettings:async()=>({themeMode:'system',coreTabStates:{local:{tabs:[{id:'old',sessionId:'old',title:'历史',type:'chat'}],activeTabId:'old'}}}),
  listCoreTargets:async()=>target,listAgentSessions:async()=>[],listWorkspaces:async()=>[],
  listConversations:async()=>[{id:'core-chat:machine:old',title:'历史',createdAt:0,updatedAt:0}],
  updateSettings:async()=>({}),onFailure:error=>{throw error},
 })
 cleanups.push(navigation.dispose)
 await navigation.ready
 expect(store.get(currentConversationIdAtom)).toBe('core-chat:machine:old')
 expect(store.get(activeTabIdAtom)).toBe('core-chat:machine:old')
})

test('接任刷新共享历史后只合并本窗口历史，等待期间不保存陈旧整包', async () => {
 const store=createStore()
 store.set(windowBootstrapAtom,{windowId:'next',kind:'session',isPrimary:false,initialTab:null,openWindows:[]})
 let reads=0
 let release!:(settings:AppSettings)=>void
 const latest=new Promise<AppSettings>(resolve=>{release=resolve})
 const writes:Partial<AppSettings>[]=[]
 const nav=initializeCoreSessionNavigation(store,{
  isolated:true,getSettings:()=>++reads===1?Promise.resolve({themeMode:'system',coreTabStates:{'core:linux':state(remoteSession)}}):latest,
  listCoreTargets:async()=>snapshot('local',0),listAgentSessions:async()=>[localSession],listConversations:async()=>[],listWorkspaces:async()=>[workspace('local-ws')],
  updateSettings:async patch=>{writes.push(patch)},onFailure:error=>{throw error},
 })
 cleanups.push(nav.dispose)
 await nav.ready
 applyInitialWindowTab(store,{...state(localSession).tabs[0]!,type:'agent',draft:'keep'})
 store.set(appWindowsAtom,[{windowId:'next',isPrimary:true,sessions:[]}])
 expect(reads).toBe(2)
 expect(nav.beforeUnload()).toBeNull()
 const flushing=nav.flush()
 await settle()
 expect(writes).toHaveLength(0)
 const newer={...state(remoteSession),activeTabId:'new-at-old-primary-close'}
 release({themeMode:'system',coreTabStates:{'core:linux':newer,'core:new':state(remoteSession)}})
 await flushing
 expect(writes.at(-1)?.coreTabStates?.['core:linux']?.activeTabId).toBe('new-at-old-primary-close')
 expect(writes.at(-1)?.coreTabStates?.['core:new']).toEqual(state(remoteSession))
 expect(writes.at(-1)?.coreTabStates?.local?.activeTabId).toBe(localSession.id)
 expect(store.get(activeTabIdAtom)).toBe(localSession.id)
 expect(store.get(agentSessionDraftsAtom).get(localSession.id)).toBe('keep')
})

test('次级窗口接任后不重载当前Tab或草稿，只接续主窗口导航持久化', async () => {
 const x=setup({coreTabStates:{'core:linux':state(remoteSession)}},{isolated:true})
 x.store.set(windowBootstrapAtom,{windowId:'successor',kind:'session',isPrimary:false,initialTab:null,openWindows:[]})
 await x.navigation.ready
 applyInitialWindowTab(x.store,{...state(localSession).tabs[0]!,type:'agent',draft:'keep draft'})
 await x.navigation.flush()
 expect(x.writes).toHaveLength(0)
 x.store.set(appWindowsAtom,[{windowId:'successor',isPrimary:true,sessions:[{type:'agent',sessionId:localSession.id}]}])
 await x.navigation.flush()
 expect(x.store.get(windowBootstrapAtom)?.isPrimary).toBe(true)
 expect(x.store.get(activeTabIdAtom)).toBe(localSession.id)
 expect(x.store.get(agentSessionDraftsAtom).get(localSession.id)).toBe('keep draft')
 expect(x.writes.at(-1)?.coreTabStates?.local?.activeTabId).toBe(localSession.id)
 expect(x.writes.at(-1)?.coreTabStates?.['core:linux']?.activeTabId).toBe(remoteId)
 expect(x.navigation.beforeUnload()?.coreTabStates?.local?.activeTabId).toBe(localSession.id)
})

test('次级窗口不读取 primary 导航，不向共享 settings 落盘，Core 切换仍保留自身历史', async () => {
 const {store,navigation,writes}=setup({coreTabStates:{local:state(localSession)}},{isolated:true})
 await navigation.ready
 expect(store.get(tabsAtom).filter(tab=>tab.type==='agent')).toEqual([])
 store.set(tabsAtom,ensureScratchPadTab(state(localSession).tabs))
 store.set(activeTabIdAtom,localSession.id)
 store.set(coreTargetsAtom,snapshot('linux-target',1))
 await settle()
 store.set(coreTargetsAtom,snapshot('local',2))
 await settle()
 expect(store.get(activeTabIdAtom)).toBe(localSession.id)
 await navigation.flush()
 expect(navigation.beforeUnload()).toBeNull()
 expect(writes).toEqual([])
})

test('两个窗口各自消费 Core 路由快照，切换 A 不改变 B 的目录与导航', async () => {
 const a=setup({}, {isolated:true})
 const b=setup({}, {isolated:true})
 await Promise.all([a.navigation.ready,b.navigation.ready])
 b.store.set(tabsAtom,ensureScratchPadTab(state(localSession).tabs))
 b.store.set(activeTabIdAtom,localSession.id)
 a.store.set(coreTargetsAtom,snapshot('linux-target',1))
 await settle()
 expect(a.store.get(coreTargetsAtom).currentId).toBe('linux-target')
 expect(a.store.get(agentSessionsAtom).map(item=>item.id)).toEqual([remoteId])
 expect(b.store.get(coreTargetsAtom).currentId).toBe('local')
 expect(b.store.get(agentSessionsAtom).map(item=>item.id)).toEqual([localSession.id])
 expect(b.store.get(activeTabIdAtom)).toBe(localSession.id)
})

test('窗口 Core 新快照收到后，迟到 list 查询不回退路由', () => {
 const current={...snapshot('linux-target',2),revision:5}
 expect(mergeWindowCoreSnapshot(current,{...snapshot('local',1),revision:4})).toBe(current)
 expect(mergeWindowCoreSnapshot(snapshot('local',0),snapshot('linux-target',1)).currentId).toBe('linux-target')
})

test('初始点查先于无关目录确认，迟到目录保留用户选择；点查失败不确认', async () => {
 for (const fail of [false,true]) {
  const store=createStore()
  store.set(coreTargetsAtom,snapshot('local',0))
  let release!:(items:AgentWorkspace[])=>void
  const slow=new Promise<AgentWorkspace[]>(resolve=>{release=resolve})
  let confirmed=0
  const nav=initializeCoreSessionNavigation(store,{
   isolated:true,getSettings:async()=>({themeMode:'system'}),listCoreTargets:async()=>snapshot('local',0),
   listAgentSessions:async()=>[localSession],listConversations:async()=>[],listWorkspaces:()=>slow,
   updateSettings:async()=>({}),onFailure:()=>{},seedInitialSession:async()=>fail?null:localSession,
   onInitialSessionReady:()=>{confirmed++;store.set(tabsAtom,state(localSession).tabs);store.set(activeTabIdAtom,localSession.id)},
  })
  await settle()
  expect(confirmed).toBe(fail?0:1)
  if(!fail){store.set(activeTabIdAtom,null)}
  release([workspace('local-ws')]);await nav.ready
  if(!fail)expect(store.get(activeTabIdAtom)).toBeNull()
  nav.dispose()
 }
})

test('seed 后目录失败保持 Tab 草稿 ready，并可切换下一 Core；迟到空列表不删已点查目标', async () => {
 for(const rejectCatalog of [true,false]) {
  const store=createStore();store.set(coreTargetsAtom,snapshot('local',0))
  let reject!:(e:Error)=>void,resolve!:(items:AgentSessionMeta[])=>void
  const catalog=new Promise<AgentSessionMeta[]>((res,rej)=>{resolve=res;reject=rej})
  let failures=0
  const nav=initializeCoreSessionNavigation(store,{
   isolated:true,getSettings:async()=>({themeMode:'system'}),listCoreTargets:async()=>snapshot('local',0),
   listAgentSessions:()=>store.get(coreTargetsAtom).currentId==='local'?catalog:Promise.resolve([remoteSession]),
   listConversations:async()=>[],listWorkspaces:async()=>[workspace('local-ws'),workspace('linux-ws')],
   updateSettings:async()=>({}),onFailure:()=>{failures++},seedInitialSession:async()=>localSession,
   onInitialSessionReady:()=>applyInitialWindowTab(store,{...state(localSession).tabs[0]!,type:'agent',draft:'saved'}),
  })
  await settle()
  if(rejectCatalog)reject(new Error('catalog offline'));else resolve([])
  await nav.ready
  expect(store.get(coreSessionNavigationPhaseAtom)).toBe('ready')
  expect(store.get(activeTabIdAtom)).toBe(localSession.id)
  expect(store.get(agentSessionDraftsAtom).get(localSession.id)).toBe('saved')
  expect(failures).toBe(rejectCatalog?1:0)
  store.set(coreTargetsAtom,snapshot('linux-target',1));await settle()
  expect(store.get(coreSessionNavigationPhaseAtom)).toBe('ready')
  expect(store.get(agentSessionsAtom).map(item=>item.id)).toEqual([remoteId])
  nav.dispose()
 }
})
