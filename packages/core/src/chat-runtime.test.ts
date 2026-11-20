import { describe, expect, test } from 'bun:test'
import { createChatRuntime } from './chat-runtime.ts'
import type { ChatRuntimePorts } from './chat-runtime-ports.ts'
import type { Channel, ChatMessage } from '@profer/shared'

const channel: Channel = { id: 'test', name: '测试', provider: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: '', enabled: true, models: [{ id: 'test', name: '测试', enabled: true }], createdAt: 1, updatedAt: 1 }
function fixture() {
  const messages: ChatMessage[] = []
  const events: Array<{ topic: string; payload: unknown }> = []
  let finish: (() => void) | undefined
  let blocked = false
  let fail = false
  const ports: ChatRuntimePorts = {
    emit: (_id, topic, payload) => { events.push({ topic, payload }) },
    routePluginModel: (_key, input) => input, listChannels: () => [channel], decryptApiKey: () => 'fixture',
    readAttachmentAsBase64: () => { throw new Error('禁止附件') }, isImageAttachment: () => false, isDocumentAttachment: () => false,
    extractTextFromAttachment: async () => '', getEffectiveProxyUrl: async () => undefined,
    getFetchFn: () => (async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        const send = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
        send({ choices: [{ delta: { reasoning_content: '推理', content: '回答' } }] })
        finish = () => { send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close() }
        init?.signal?.addEventListener('abort', () => controller.error(new Error('abort')))
        if (fail) setTimeout(() => controller.error(new Error('fixture failure')), 5)
        else if (!blocked) finish()
      } })
      return new Response(stream)
    }) as typeof fetch,
    getEnabledTools: () => ({ tools: [], systemPromptAppend: '' }), executeToolCalls: async () => [],
    editionProviders: { credentials: { shouldUseManagedRoute: () => false, managedPath: () => { throw new Error('禁止商业请求') } }, account: { getSession: async () => null, recoverSession: async () => null }, errors: { detectInsufficientCredits: () => null } },
    syncRecoveredChannels: async () => {}, resolveEditionBearerToken: () => { throw new Error('禁止商业请求') },
    searchKnowledgeItemsForChat: async () => [], prepareChatKnowledgeRequest: async input => ({ providerUserMessage: input.userMessage, effectiveReferences: [], knowledgeContextChars: 0 }),
    normalizeChatStreamError: () => ({ message: '请求失败' }),
    conversations: { DEFAULT_CONVERSATION_TITLE: '新对话', appendBranchTail: (_id, message) => { const result = { ...message, id: String(messages.length), createdAt: 1, parentId: message.parentId ?? null }; messages.push(result); return result }, getConversationBranch: () => [...messages], getConversationMeta: () => null, updateConversationMeta: () => { throw new Error('无元数据') } },
    titlePolicy: { MAX_TITLE_LENGTH: 20, SHORT_MESSAGE_THRESHOLD: 4, buildTitlePrompt: value => value, buildWindowTitlePrompt: values => values.join(''), collectTitleSources: values => values, mergeTitleRefineAttempts: (a, b) => Math.max(a ?? 0, b), planTitleWindow: () => ({ action: 'skip', reason: 'locked' }), preflightTitleWindow: () => ({ action: 'skip', reason: 'locked' }), sanitizeGeneratedTitle: value => typeof value === 'string' ? value : null },
  }
  return { runtime: createChatRuntime(ports), messages, events, fail: () => { fail = true }, block: () => { blocked = true }, finish: () => finish?.() }
}
const input = { conversationId: 'test', runId: 'run', userMessage: '问题', channelId: 'test', modelId: 'test', messageHistory: [] }
describe('共享 Chat runtime 的真实 SSE 行为', () => {
  test('Given 有效模型 When SSE 文本和推理完成 Then 保存完整回复并发完成事件', async () => {
    const f = fixture(); await f.runtime.sendMessage(input)
    expect(f.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(f.messages[1]?.content).toBe('回答'); expect(f.messages[1]?.reasoning).toBe('推理')
    expect(f.events.at(-1)?.topic).toBe('chat:stream:complete')
  })
  test('Given 无效模型 When 发送 Then 无落盘且错误', async () => {
    const f = fixture(); await f.runtime.sendMessage({ ...input, modelId: 'missing' })
    expect(f.messages).toHaveLength(0); expect(f.events.at(-1)?.topic).toBe('chat:stream:error')
  })
  test('Given SSE 出错 When 发送 Then 发错误事件且释放运行登记', async () => {
    const f = fixture(); f.fail(); await f.runtime.sendMessage(input)
    expect(f.events.at(-1)?.topic).toBe('chat:stream:error')
    await f.runtime.sendMessage({ ...input, runId: 'retry' })
    expect(f.messages.filter(m => m.role === 'user')).toHaveLength(2)
  })
  test('Given 活跃流 When 并发发送并停止 Then 拒绝并发且部分回复落盘', async () => {
    const f = fixture(); f.block(); const first = f.runtime.sendMessage(input)
    await new Promise(resolve => setTimeout(resolve, 15))
    await f.runtime.sendMessage({ ...input, runId: 'second' })
    expect(f.messages.filter(m => m.role === 'user')).toHaveLength(1)
    f.runtime.stopGeneration('test'); await first
    expect(f.messages[1]?.stopped).toBe(true); expect(f.messages[1]?.content).toBe('回答')
  })
})
