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
let events: Array<{ topic: string; payload: { error?: string; model?: string; message?: { id?: string; role?: string; content?: string } } }> = []
let persisted: unknown[] = []
let streamCalls = 0
let titleCalls = 0
let titleResult: string | null = 'fixture-title'
let recover = false
let commercial = false
let synced = 0
let decryptFails = false
let invalidRelay = false

// 所有运行时依赖均为 fixture，模块导入不会读取用户配置或访问网络。
mock.module('./plugins/plugin-routing', () => ({ routePluginModel: (_key: string, input: ChatSendInput) => input }))
mock.module('./channel-manager', () => ({
  listChannels: () => channels,
  getVisibleChannelById: (id: string) => channels.find((channel) => channel.id === id),
  decryptApiKey: () => { decrypts += 1; if (decryptFails) throw new Error('fixture-decrypt-failure'); return 'fixture-key' },
  isCommercialMode: () => commercial, canSelfConfig: () => true,
  syncChannelsFromServer: async () => { synced += 1; channels = refreshedChannels },
}))
mock.module('./chat-stream-bus', () => ({ pushChatStream: (_wc: unknown, _id: string, topic: string, payload: { error?: string; model?: string; message?: { id?: string; role?: string; content?: string } }) => events.push({ topic, payload }) }))
// 账号与路由策略已收口到发行版契约：mock 接缝从 auth-service 移到 ./edition。
// 本文件验的是 chat-service 的 fallback 行为，不是策略本身，所以策略固定为“走代管”。
const fixtureSession = { baseUrl: 'https://fixture.invalid', token: 'fixture-token' }
mock.module('./edition', () => ({
  editionProviders: {
    id: 'commercial',
    account: {
      getSession: async () => fixtureSession,
      recoverSession: async () => {
        if (!recover) return null
        if (!channels[0]?.directDataPlane) channels = refreshedChannels
        return fixtureSession
      },
      getSessionSnapshot: () => fixtureSession,
      getSessionGeneration: () => 1,
      refreshSession: async () => true,
      restoreSession: async () => false,
      scheduleAutoRefresh: () => {},
      getMembership: () => ({ commercialMode: true, membershipTier: 'pro', canSelfConfig: true }),
    },
    // 与 commercial-routing-policy 一致：只由商业模式决定；official-channel 在本文件已 mock 为 true。
    credentials: {
      shouldUseManagedRoute: (channel: { directDataPlane?: boolean }, options?: { respectDirectDataPlane?: boolean }) =>
        commercial && (!options?.respectDirectDataPlane || channel.directDataPlane !== true),
      shouldUseBearerAuth: () => commercial,
      managedPath: (kind: string) =>
        ({ messages: '/v1/proxy/messages', chat: '/v1/proxy/chat', images: '/v1/proxy/images/generations', imageEdits: '/v1/proxy/images/edits', root: '/v1/proxy' } as Record<string, string>)[kind] ?? '',
      managedImageOperationPath: (operation: string, key: string) =>
        `/v1/proxy/images/operations/by-idempotency/${operation}/${key}`,
    },
    // 商业版会识别额度不足；本文件走商业桩，保持与生产一致。
    errors: { detectInsufficientCredits: () => null },
    remote: { getRelayTicket: async () => null },
    registerIpc: () => {},
  },
}))
mock.module('./conversation-manager', () => ({ appendMessage: () => {},
  appendBranchTail: (_id: string, message: Record<string, unknown>) => { const persistedMessage = { id: 'fixture-user-message', ...message }; persisted.push(persistedMessage); return persistedMessage },
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
  fetchTitle: async () => { titleCalls += 1; return titleResult },
  fetchTitleWithRetry: async () => { titleCalls += 1; return { title: titleResult } },
  resolveTitleBaseUrl: (_provider: string, baseUrl: string) => baseUrl,
  detectInsufficientCredits: () => null,
}))
const { sendMessage, generateTitle } = await import('./chat-service')
const input: ChatSendInput = { conversationId: 'fixture-conversation', runId: 'fixture-run', userMessage: 'fixture message', messageHistory: [], channelId: 'fixture', modelId: 'model' }

beforeEach(() => {
  channels = [{ ...fixture }]; refreshedChannels = []
  decrypts = 0; requests = []; events = []; persisted = []; streamCalls = 0; titleCalls = 0
  titleResult = 'fixture-title'
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
  test('Claude-only 渠道没有 Chat 端点时报告端点缺失，而不是仅支持 Pi Agent', async () => {
    channels = [{ ...fixture, provider: 'anthropic', baseUrl: '', agentRuntimes: ['claude'] }]
    await sendMessage(input, null)
    expect(events).toHaveLength(1)
    expect(events[0]?.topic).toBe(CHAT_IPC_CHANNELS.STREAM_ERROR)
    expect(events[0]?.payload.error).toContain('未配置 Chat 端点')
    expect(events[0]?.payload.error).not.toContain('仅支持 Pi Agent')
    expect(decrypts).toBe(0); expect(requests).toHaveLength(0); expect(persisted).toHaveLength(0)
  })
  test('停用/缺失的绑定模型不解密、不请求、不替换其它 enabled 模型', async () => {
    for (const modelId of ['model', 'missing']) {
      channels = [{ ...fixture, models: [{ id: 'model', name: 'Model', enabled: false }, fixture.models[1]!] }]
      await sendMessage({ ...input, modelId }, null)
    }
    expect(events.every((event) => event.payload.error?.includes('模型配置已失效'))).toBe(true)
    expect(decrypts).toBe(0); expect(requests).toHaveLength(0); expect(persisted).toHaveLength(0)
  })
  test('正常 Chat 保留原 modelId 并推送用户消息/chunk/complete', async () => {
    await sendMessage(input, null)
    expect(requests.map((request) => request.modelId)).toEqual(['model'])
    // 用户消息落盘后先广播（含真实 id），移动端才能实时看到桌面发起的指令。
    expect(events.map((event) => event.topic)).toEqual([
      CHAT_IPC_CHANNELS.STREAM_USER,
      CHAT_IPC_CHANNELS.STREAM_CHUNK,
      CHAT_IPC_CHANNELS.STREAM_COMPLETE,
    ])
    expect(events[0]?.payload.message).toMatchObject({ role: 'user', content: 'fixture message' })
    expect(events[0]?.payload.message?.id).toBeTruthy()
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
  test('provider 标题响应失败返回 null，不用首条消息伪装成功', async () => {
    titleResult = null
    const title = await generateTitle({
      channelId: 'fixture', modelId: 'model',
      userMessage: '请梳理 Profer 标题链路和重新生成失败原因',
      contextMessages: ['请梳理 Profer 标题链路和重新生成失败原因'],
    })
    expect(title).toBeNull()
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
