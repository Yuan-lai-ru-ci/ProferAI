import { describe, expect, test } from 'bun:test'
import { CHAT_IPC_CHANNELS } from '@profer/shared'
import { routeCoreChat, namespaceCoreChatId, parseCoreChatId, type ChatRoutingSnapshot } from './core-chat-routing'

const scope = { __proferCoreResourceScope: { targetId: 'linux', generation: 4 } }
function state(overrides: Partial<ChatRoutingSnapshot> = {}): ChatRoutingSnapshot {
  return { targetId: 'linux', generation: 4, coreId: 'linux-core', ownsBusinessData: true, capabilities: ['chat'], client: { chatOperation: async <T>() => undefined as T }, ...overrides }
}

describe('Core Chat 调用归属', () => {
  test('Given 同rawId两端对话 When 编码 Then 拥有独立Chat命名空间', () => {
    const id = namespaceCoreChatId('same-id', 'linux/core:one')
    expect(parseCoreChatId(id)).toEqual({ coreId: 'linux/core:one', conversationId: 'same-id' })
    expect(parseCoreChatId('core:linux:same-id')).toBeNull()
    expect(parseCoreChatId('core-chat:%E0%A4%:same-id')).toBeNull()
  })
  test('Given 远端列表 When 请求 Then 调用当前Core且命名空间只映射对话ID', async () => {
    const current = state({ client: { chatOperation: async <T>() => [{ id: 'raw', title: 'linux', activePath: ['message'] }] as T } })
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, [true, scope], () => current)).resolves.toEqual({ result: [{ id: 'core-chat:linux-core:raw', title: 'linux', activePath: ['message'] }] })
  })
  test('Given 远端发送 When 同scope Then 转rawId并在connect后继续保护', async () => {
    let calls: unknown[] = []
    const current = state({ client: { chatOperation: async <T>(operation: string, args: unknown[], assertCurrent?: () => void) => { assertCurrent?.(); calls = [operation, args]; return undefined as T } } })
    await routeCoreChat(CHAT_IPC_CHANNELS.SEND_MESSAGE, [{ conversationId: namespaceCoreChatId('raw', 'linux-core'), runId: 'run', userMessage: 'hello', channelId: 'linux-channel', modelId: 'chosen-model' }, scope], () => current)
    expect(calls).toEqual([CHAT_IPC_CHANNELS.SEND_MESSAGE, [{ conversationId: 'raw', runId: 'run', userMessage: 'hello', channelId: 'linux-channel', modelId: 'chosen-model' }]])
  })
  test.each([
    ['缺scope', [], '缺少'],
    ['过期scope', [{ __proferCoreResourceScope: { targetId: 'mac', generation: 3 } }], '过期'],
  ])('Given %s When 请求 Then 拒绝而非读本机', async (_name, args, message) => {
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, args, () => state())).rejects.toThrow(message)
  })
  test('Given 断连或无能力 When 请求 Then 准确拒绝', async () => {
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, [scope], () => state({ client: null }))).rejects.toThrow('不会回退')
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, [scope], () => state({ capabilities: [] }))).rejects.toThrow('不支持')
  })
  test('Given 另一Core或裸对话ID When 当前Linux读取 Then 不读同名对话', async () => {
    for (const id of ['core-chat:mac-core:raw', 'raw']) await expect(routeCoreChat(CHAT_IPC_CHANNELS.GET_MESSAGES, [id, scope], () => state())).rejects.toThrow('所属Core')
  })
  test('Given 旧local桌面 When 裸ID请求 Then 保留原处理器；namespaced旧目标不退桌面', async () => {
    const local = state({ targetId: 'local', ownsBusinessData: false, client: null })
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.GET_MESSAGES, ['raw'], () => local)).resolves.toBeNull()
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.GET_MESSAGES, ['core-chat:linux-core:raw'], () => local)).rejects.toThrow('所属Core')
  })
  test('Given 普通正文以Core前缀开头 When 旧桌面或远端发送 Then 不将正文误认身份', async () => {
    const local = state({ targetId: 'local', ownsBusinessData: false, client: null })
    for (const userMessage of ['core-chat:这是正文', 'core-chat-file:这是正文']) {
      await expect(routeCoreChat(CHAT_IPC_CHANNELS.SEND_MESSAGE, [{ conversationId: 'raw', userMessage }], () => local)).resolves.toBeNull()
      const current = state()
      await expect(routeCoreChat(CHAT_IPC_CHANNELS.SEND_MESSAGE, [{ conversationId: 'core-chat:linux-core:raw', userMessage }, scope], () => current)).resolves.toEqual({ result: undefined })
    }
  })
  test('Given HTTP迟到 When 已切目标 Then 拒绝响应', async () => {
    let current = state()
    current.client = { chatOperation: async <T>() => { current = state({ targetId: 'mac', generation: 5 }); return [] as T } }
    await expect(routeCoreChat(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, [scope], () => current)).rejects.toThrow('旧Core')
  })
})
