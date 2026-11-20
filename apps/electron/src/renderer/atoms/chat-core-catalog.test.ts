import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { Channel } from '@profer/shared'
import { channelsAtom, channelsLoadedAtom, conversationsAtom, conversationModelAtomFamily } from './chat-atoms'
import { coreChannelsAtom, coreChannelsLoadedAtom, coreTargetsAtom } from './core-target-atoms'

const channel: Channel = { id:'same', name:'Core渠道', provider:'openai', apiKey:'', baseUrl:'https://fixture.invalid', enabled:true, models:[{id:'model',name:'Model',enabled:true}],createdAt:0,updatedAt:0 }
test('Given Linux会话和Mac同名渠道 When Core目录未加载 Then 不得借Mac目录接受模型绑定', () => {
 const store=createStore()
 store.set(coreTargetsAtom,{currentId:'linux',generation:1,targets:[]})
 store.set(channelsAtom,[channel]);store.set(channelsLoadedAtom,true)
 store.set(conversationsAtom,[{id:'core-chat:linux:chat',title:'Chat',channelId:'same',modelId:'model',createdAt:0,updatedAt:0}])
 const model=conversationModelAtomFamily('core-chat:linux:chat')
 expect(store.get(model)).toBeNull()
 store.set(coreChannelsAtom,[channel]);store.set(coreChannelsLoadedAtom,{targetId:'linux',generation:1})
 expect(store.get(model)).toEqual({channelId:'same',modelId:'model'})
 store.set(coreTargetsAtom,{currentId:'other',generation:2,targets:[]})
 expect(store.get(model)).toBeNull()
})
