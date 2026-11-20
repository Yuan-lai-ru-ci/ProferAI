import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { coreTargetsAtom, ownsCoreChat } from '../atoms/core-target-atoms'
import { streamingStatesAtom, chatMessageRefreshAtom, chatStreamErrorsAtom } from '../atoms/chat-atoms'
import { applyCoreChatSnapshot, markCoreChatDisconnected } from './core-chat-recovery'

function fixture() {
 const store=createStore()
 store.set(coreTargetsAtom,{currentId:'local',generation:2,targets:[{id:'local',kind:'local',name:'本机',status:'connected',coreId:'local-id',capabilities:['chat']}]})
 store.set(streamingStatesAtom,new Map([['core-chat:local-id:chat',{runId:'old',streaming:true,content:'partial',reasoning:'',toolActivities:[],startedAt:1}]]))
 return store
}
test('Given 本机Core有chat能力 When 判断渠道归属 Then 使用Core目录',()=>{
 expect(ownsCoreChat(fixture().get(coreTargetsAtom))).toBe(true)
})
test('Given Core重启后无activeRun When 收到snapshot Then 旧stream清除并重读服务端消息',()=>{
 const store=fixture(); const cancelled:string[]=[]
 expect(applyCoreChatSnapshot(store,{targetId:'local',generation:2,conversations:[],activeRuns:[]},id=>cancelled.push(id))).toBe(true)
 expect(store.get(streamingStatesAtom).size).toBe(0)
 expect(store.get(chatMessageRefreshAtom).get('core-chat:local-id:chat')).toBe(1)
 expect(cancelled).toEqual(['core-chat:local-id:chat'])
})
test('Given 当前代次已变 When 旧快照迟到 Then 不清除现有stream或刷新消息',()=>{
 const store=fixture()
 expect(applyCoreChatSnapshot(store,{targetId:'local',generation:1,conversations:[],activeRuns:[]},()=>{throw new Error('不应取消')})).toBe(false)
 expect(store.get(streamingStatesAtom).get('core-chat:local-id:chat')?.streaming).toBe(true)
 expect(store.get(chatMessageRefreshAtom).size).toBe(0)
})
test('Given 断连 When 恢复快照仍有activeRun Then 显示错误后恢复同run且不重发',()=>{
 const store=fixture();const target=store.get(coreTargetsAtom)
 store.set(coreTargetsAtom,{...target,targets:target.targets.map(item=>({...item,status:'disconnected' as const}))})
 markCoreChatDisconnected(store,()=>{})
 expect(store.get(streamingStatesAtom).get('core-chat:local-id:chat')?.streaming).toBe(false)
 expect(store.get(chatStreamErrorsAtom).get('core-chat:local-id:chat')).toContain('未自动重发')
 applyCoreChatSnapshot(store,{targetId:'local',generation:2,conversations:[],activeRuns:[{conversationId:'core-chat:local-id:chat',runId:'old'}]},()=>{})
 expect(store.get(streamingStatesAtom).get('core-chat:local-id:chat')?.streaming).toBe(true)
 expect(store.get(chatStreamErrorsAtom).has('core-chat:local-id:chat')).toBe(false)
})
