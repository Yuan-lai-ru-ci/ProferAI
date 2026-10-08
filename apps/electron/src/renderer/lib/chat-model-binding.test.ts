import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { Channel, ConversationMeta } from '@profer/shared'
import { authStatusAtom } from '../atoms/identity-atoms'
import {
  channelsAtom, channelsLoadedAtom, conversationModelAtomFamily, conversationModelsAtom,
  conversationsAtom, selectedModelAtom,
} from '../atoms/chat-atoms'

const baseChannel: Channel = { id: 'local', name: 'Local', provider: 'openai', apiKey: 'encrypted',
  baseUrl: 'https://fixture.invalid', enabled: true, models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1 }
const conversation = (id: string, modelId = 'model'): ConversationMeta => ({ id, title: id, channelId: 'local', modelId, createdAt: 1, updatedAt: 1 })
function setup() {
  const store = createStore()
  store.set(authStatusAtom, { isLoggedIn: true })
  store.set(channelsAtom, [baseChannel])
  store.set(channelsLoadedAtom, true)
  return store
}
describe('Chat per-conversation 模型绑定（本地 fixture）', () => {
  test('两个会话各读自己的 metadata/override，不共享另一个会话的选择', () => {
    const store = setup()
    store.set(conversationsAtom, [conversation('a'), conversation('b', 'other')])
    store.set(conversationModelsAtom, new Map([['a', { channelId: 'local', modelId: 'model' }]]))
    expect(store.get(conversationModelAtomFamily('a'))).toEqual({ channelId: 'local', modelId: 'model' })
    expect(store.get(conversationModelAtomFamily('b'))).toBeNull()
  })
  test('显式清空只影响当前会话，不回落全局默认或改写历史 metadata', () => {
    const store = setup()
    store.set(selectedModelAtom, { channelId: 'local', modelId: 'model' })
    store.set(conversationsAtom, [conversation('a')])
    store.set(conversationModelsAtom, new Map([['a', null]]))
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
    expect(store.get(conversationsAtom)[0]!.modelId).toBe('model')
  })
  test('目录加载后停用/删除模型返回失效，不能继续发请求', () => {
    const store = setup()
    store.set(conversationsAtom, [conversation('a')])
    store.set(channelsAtom, [{ ...baseChannel, models: [{ ...baseChannel.models[0]!, enabled: false }] }])
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
    store.set(channelsAtom, [])
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
  })
  test('Chat 不展示 OAuth-only xAI 与 Codex，未登录不展示官方缓存', () => {
    const store = setup()
    const oauth = { ...baseChannel, id: 'xai-oauth', provider: 'xai' as const, credentialMode: 'oauth' as const }
    const codex = { ...baseChannel, id: 'codex', provider: 'openai-codex' as const }
    store.set(channelsAtom, [oauth, codex])
    store.set(conversationsAtom, [conversation('a')])
    store.set(conversationModelsAtom, new Map([['a', { channelId: 'xai-oauth', modelId: 'model' }]]))
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
    store.set(conversationModelsAtom, new Map([['a', { channelId: 'codex', modelId: 'model' }]]))
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
    store.set(channelsAtom, [{ ...baseChannel, serverManaged: true, id: 'newapi-official' }])
    store.set(conversationModelsAtom, new Map([['a', { channelId: 'newapi-official', modelId: 'model' }]]))
    store.set(authStatusAtom, { isLoggedIn: false })
    expect(store.get(conversationModelAtomFamily('a'))).toBeNull()
  })
})
