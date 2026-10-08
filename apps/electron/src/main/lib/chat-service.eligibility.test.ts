import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { CHAT_IPC_CHANNELS } from '@profer/shared'
import type { Channel, ChatSendInput } from '@profer/shared'

const fixture: Channel = { id: 'fixture', name: 'Fixture', provider: 'openai',
  baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-encrypted', enabled: true,
  models: [{ id: 'model', name: 'Model', enabled: true }, { id: 'other', name: 'Other', enabled: true }],
  createdAt: 1, updatedAt: 1 }
let channels: Channel[] = []
let refreshedChannels: Channel[] = []
let decrypts = 0
let requests: Array<{ modelId: string; baseUrl: string }> = []
let events: Array<{ topic: string; payload: { error?: string; model?: string } }> = []
let persisted: unknown[] = []
let streamCalls = 0
let titleCalls = 0
let recover = false
let commercial = false
let synced = 0
let decryptFails = false
let invalidRelay = false

// 所有运行时依赖均为 fixture，模块导入不会读取用户配置或访问网络。
mock.module('./plugins/plugin-routing', () => ({ routePluginModel: (_key: string, input: ChatSendInput) => input }))
mock.module('./channel-manager', () => ({
  listChannels: () => channels,
  decryptApiKey: () => { decrypts += 1; if (decryptFails) throw new Error('fixture-decrypt-failure'); return 'fixture-key' },
  isCommercialMode: () => commercial, canSelfConfig: () => true,
  syncChannelsFromServer: async () => { synced += 1; channels = refreshedChannels },
}))
mock.module('./chat-stream-bus', () => ({ pushChatStream: (_wc: unknown, _id: string, topic: string, payload: { error?: string; model?: string }) => events.push({ topic, payload }) }))
mock.module('./auth-service', () => ({
  getTeamAuthWithRefresh: async () => ({ baseUrl: 'https://fixture.invalid', token: 'fixture-token' }),
  recoverCommercialProxyAuth: async () => {
    if (!recover) return null
    if (!channels[0]?.directDataPlane) channels = refreshedChannels
    return { baseUrl: 'https://fixture.invalid', token: 'fixture-token' }
  },
}))
mock.module('./conversation-manager', () => ({ appendMessage: () => {},
  appendBranchTail: (_id: string, message: unknown) => persisted.push(message),
  updateConversationMeta: () => {}, getConversationBranch: () => [], getConversationMeta: () => null,
  DEFAULT_CONVERSATION_TITLE: '新对话',
}))
mock.module('./attachment-service', () => ({ readAttachmentAsBase64: () => { throw new Error('禁止读取真实附件') }, isImageAttachment: () => false }))
mock.module('./document-parser', () => ({ extractTextFromAttachment: () => { throw new Error('禁止读取真实文档') }, isDocumentAttachment: () => false }))
mock.module('./proxy-fetch', () => ({ getFetchFn: () => () => { throw new Error('禁止真实请求') } }))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./chat-tool-registry', () => ({ getEnabledTools: () => ({ tools: [], systemPromptAppend: '' }) }))
mock.module('./chat-tool-executor', () => ({ executeToolCalls: () => { throw new Error('禁止真实工具') } }))
mock.module('./build-target', () => ({ isCommercialBuild: () => false }))
mock.module('./official-channel', () => ({ isOfficialManagedChannel: () => true }))
mock.module('./knowledge-item-service', () => ({ searchKnowledgeItemsForChat: () => [] }))
mock.module('./chat-knowledge-request', () => ({ prepareChatKnowledgeRequest: async (input: { userMessage: string }) => ({ providerUserMessage: input.userMessage, effectiveReferences: [], knowledgeContextChars: 0 }) }))
mock.module('@profer/core', () => ({
  getAdapter: () => ({
    buildStreamRequest: (input: { modelId: string; baseUrl: string }) => { requests.push(input); return { url: input.baseUrl, headers: {}, body: '{}' } },
    buildTitleRequest: (input: { modelId: string; baseUrl: string }) => { requests.push(input); return { url: input.baseUrl, headers: {}, body: '{}' } },
  }),
  streamSSE: async (input: { onEvent: (event: { type: string; delta: string }) => void }) => {
    streamCalls += 1
    if (recover && streamCalls === 1) throw new Error(invalidRelay ? 'API 错误 (401): relay 令牌无效' : 'fixture-direct-failure')
    input.onEvent({ type: 'chunk', delta: 'fixture-reply' })
    return { content: 'fixture-reply' }
  },
  fetchTitle: async () => { titleCalls += 1; return 'fixture-title' },
  detectInsufficientCredits: () => null,
}))
const { sendMessage, generateTitle } = await import('./chat-service')
const input: ChatSendInput = { conversationId: 'fixture-conversation', runId: 'fixture-run', userMessage: 'fixture message', messageHistory: [], channelId: 'fixture', modelId: 'model' }

beforeEach(() => {
  channels = [{ ...fixture }]; refreshedChannels = []
  decrypts = 0; requests = []; events = []; persisted = []; streamCalls = 0; titleCalls = 0
  recover = false; commercial = false; synced = 0; decryptFails = false; invalidRelay = false
})

describe('Chat 服务资格与事件（完全 mock）', () => {
  for (const patch of [
    { provider: 'openai-codex' as const },
    { provider: 'xai' as const, credentialMode: 'oauth' as const },
  ]) {
    test(`${patch.provider} Agent-only 在解密前发送明确错误`, async () => {
      channels = [{ ...fixture, ...patch }]; decryptFails = true
      await sendMessage(input, null)
      expect(events).toHaveLength(1)
      expect(events[0]?.topic).toBe(CHAT_IPC_CHANNELS.STREAM_ERROR)
      expect(events[0]?.payload.error).toContain('仅支持 Pi Agent')
      expect(decrypts).toBe(0); expect(requests).toHaveLength(0); expect(persisted).toHaveLength(0)
    })
  }
  test('停用/缺失的绑定模型不解密、不请求、不替换其它 enabled 模型', async () => {
    for (const modelId of ['model', 'missing']) {
      channels = [{ ...fixture, models: [{ id: 'model', name: 'Model', enabled: false }, fixture.models[1]!] }]
      await sendMessage({ ...input, modelId }, null)
    }
    expect(events.every((event) => event.payload.error?.includes('模型配置已失效'))).toBe(true)
    expect(decrypts).toBe(0); expect(requests).toHaveLength(0); expect(persisted).toHaveLength(0)
  })
  test('正常 Chat 保留原 modelId 并推送 chunk/complete', async () => {
    await sendMessage(input, null)
    expect(requests.map((request) => request.modelId)).toEqual(['model'])
    expect(events.map((event) => event.topic)).toEqual([CHAT_IPC_CHANNELS.STREAM_CHUNK, CHAT_IPC_CHANNELS.STREAM_COMPLETE])
    expect(events.at(-1)?.payload.model).toBe('model')
  })
  test('短标题与 API 标题均拒绝失效/Agent-only 绑定，不改用其它模型', async () => {
    for (const patch of [
      { enabled: false }, { provider: 'openai-codex' as const },
      { provider: 'xai' as const, credentialMode: 'oauth' as const },
      { models: [fixture.models[1]!] },
      { models: [{ id: 'model', name: 'Model', enabled: false }, fixture.models[1]!] },
    ]) {
      channels = [{ ...fixture, ...patch }]
      for (const userMessage of ['短标题', '用于验证模型资格的 fixture 长消息，不能替换用户指定的 model']) {
        expect(await generateTitle({ channelId: 'fixture', modelId: 'model', userMessage })).toBeNull()
      }
    }
    expect(decrypts).toBe(0); expect(titleCalls).toBe(0); expect(requests).toHaveLength(0)
  })
  test('有效短标题仍本地生成，长标题使用原绑定', async () => {
    expect(await generateTitle({ channelId: 'fixture', modelId: 'model', userMessage: '短标题' })).toBe('短标题')
    expect(decrypts).toBe(0)
    expect(await generateTitle({ channelId: 'fixture', modelId: 'model', userMessage: 'fixture 长消息用于标题生成并保持指定模型绑定' })).toBe('fixture-title')
    expect(requests.map((request) => request.modelId)).toEqual(['model'])
  })
  for (const patch of [
    { enabled: false }, { provider: 'openai-codex' as const },
    { provider: 'xai' as const, credentialMode: 'oauth' as const },
    { models: [fixture.models[1]!] },
    { models: [{ id: 'model', name: 'Model', enabled: false }, fixture.models[1]!] },
  ]) {
    test(`直连 fallback 拒绝同步后失效绑定 ${JSON.stringify(patch)}`, async () => {
      channels = [{ ...fixture, directDataPlane: true }]
      refreshedChannels = [{ ...fixture, directDataPlane: false, ...patch }]
      recover = true
      await sendMessage(input, null)
      expect(synced).toBe(1); expect(streamCalls).toBe(1); expect(decrypts).toBe(1)
      expect(requests.map((request) => request.modelId)).toEqual(['model'])
      expect(events.at(-1)?.topic).toBe(CHAT_IPC_CHANNELS.STREAM_ERROR)
    })
  }
  test('有效直连 fallback 仅以原 modelId 重试', async () => {
    channels = [{ ...fixture, directDataPlane: true }]
    refreshedChannels = [{ ...fixture, directDataPlane: false }]; recover = true
    await sendMessage(input, null)
    expect(streamCalls).toBe(2); expect(requests.map((request) => request.modelId)).toEqual(['model', 'model'])
    expect(events.at(-1)?.topic).toBe(CHAT_IPC_CHANNELS.STREAM_COMPLETE)
  })
  test('Relay 凭据恢复期间停用原模型则停止重试', async () => {
    commercial = true; recover = true; invalidRelay = true
    refreshedChannels = [{ ...fixture, models: [fixture.models[1]!] }]
    await sendMessage(input, null)
    expect(streamCalls).toBe(1); expect(decrypts).toBe(0)
    expect(events.at(-1)?.topic).toBe(CHAT_IPC_CHANNELS.STREAM_ERROR)
  })
})
