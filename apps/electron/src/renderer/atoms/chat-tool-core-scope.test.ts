import { expect, test } from 'bun:test'
import type { ChatToolInfo } from '@profer/shared'
import { createStore } from 'jotai/vanilla'
import { coreTargetsAtom } from './core-target-atoms'
import { chatToolsAtom, activeToolIdsAtom, hasActiveToolsAtom, chatToolsUnavailableReasonAtom, chatKnowledgeUnavailableReasonAtom } from './chat-tool-atoms'

test('Given 桌面工具已启用 When 切至没有tools能力的Core Then 不继承工具且显示能力说明', () => {
 const store=createStore()
 store.set(chatToolsAtom,[{ meta:{id:'web',name:'Web'},enabled:true,available:true } as ChatToolInfo])
 expect(store.get(activeToolIdsAtom)).toEqual(['web'])
 store.set(coreTargetsAtom,{currentId:'linux',generation:1,targets:[{id:'linux',kind:'remote',name:'Linux',status:'connected',capabilities:['chat']}]})
 expect(store.get(activeToolIdsAtom)).toEqual([])
 expect(store.get(hasActiveToolsAtom)).toBe(false)
 expect(store.get(chatToolsUnavailableReasonAtom)).toBe('当前Core暂不支持Chat工具')
 expect(store.get(chatKnowledgeUnavailableReasonAtom)).toBe('当前Core暂不支持Chat知识库')
 store.set(coreTargetsAtom,{currentId:'local',generation:2,targets:[{id:'local',kind:'local',name:'本机',status:'connected',capabilities:['chat']}]})
 expect(store.get(activeToolIdsAtom)).toEqual([])
 store.set(coreTargetsAtom,{currentId:'local',generation:3,targets:[]})
 expect(store.get(activeToolIdsAtom)).toEqual(['web'])
 expect(store.get(chatToolsUnavailableReasonAtom)).toBeNull()
})
