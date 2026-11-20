import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_IPC_CHANNELS as C } from '@profer/shared'
import { createCoreChat } from './chat'
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(fetch?: typeof globalThis.fetch) {
  const configDir = mkdtempSync(join(tmpdir(), 'core-chat-test-')); roots.push(configDir)
  const events: Array<{ channel: string; payload: unknown }> = []
  const chat = createCoreChat({ configDir, listChannels: () => [{ id: 'mock', name: 'Mock', provider: 'openai', baseUrl: 'https://mock.invalid/v1', apiKey: 'test', enabled: true, models: [{ id: 'test-model', name: 'Test', enabled: true }] }], fetch, emit: (_id, channel, payload) => events.push({ channel, payload }) })
  return { chat, events, configDir }
}
const mockFetch = (async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\ndata: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof globalThis.fetch
async function create(chat: ReturnType<typeof createCoreChat>) { return await chat.operation(C.CREATE_CONVERSATION, ['test', 'test-model', 'mock']) as { id: string } }
const input = (id: string) => ({ conversationId: id, runId: 'run-1', userMessage: 'hello', messageHistory: [], channelId: 'mock', modelId: 'test-model', thinkingEnabled: true })
async function settled(chat: ReturnType<typeof createCoreChat>) { for (let i = 0; i < 200 && chat.snapshot().activeRuns.length; i++) await Bun.sleep(5); expect(chat.snapshot().activeRuns).toHaveLength(0) }
describe('Core Chat真实共享引擎', () => {
  test('Given mock SSE When 发送 Then HTTP语义准入、推理、文本、完成和JSONL恢复', async () => {
    const { chat, events, configDir } = fixture(mockFetch); const meta = await create(chat)
    expect(await chat.operation(C.SEND_MESSAGE, [input(meta.id)])).toEqual({ accepted: true, runId: 'run-1' })
    await settled(chat)
    expect(events.some(event => event.channel === C.STREAM_REASONING)).toBe(true)
    expect(events.some(event => event.channel === C.STREAM_CHUNK)).toBe(true)
    expect(events.some(event => event.channel === C.STREAM_COMPLETE)).toBe(true)
    const messages = await chat.operation(C.GET_BRANCH, [meta.id]) as Array<{ role: string; content: string; id: string }>
    expect(messages.map(message => message.content)).toEqual(['hello', '你好'])
    const restored = createCoreChat({ configDir, listChannels: () => [], emit: () => {} })
    expect(await restored.operation(C.GET_BRANCH, [meta.id])).toEqual(messages)
    const fork = await chat.operation(C.FORK_BRANCH_AT, [meta.id, messages[0]!.id, { role: 'user', content: 'edited' }]) as { id: string }
    expect(fork.id).not.toBe(messages[0]!.id)
    expect((await chat.operation(C.GET_BRANCH, [meta.id]) as Array<{ content: string }>).at(-1)?.content).toBe('edited')
    await chat.shutdown(); await restored.shutdown()
  })
  test('Given 无效模型/工具/恶意附件 When 发送 Then 无fallback且不落孤儿消息', async () => {
    const { chat } = fixture(mockFetch); const meta = await create(chat)
    for (const patch of [{ modelId: 'missing' }, { enabledToolIds: ['native'] }, { attachments: [{ localPath: '/etc/passwd', mediaType: 'text/plain' }] }]) await expect(chat.operation(C.SEND_MESSAGE, [{ ...input(meta.id), ...patch }])).rejects.toThrow()
    expect(await chat.operation(C.GET_BRANCH, [meta.id])).toEqual([])
    await expect(chat.operation('__proto__', [])).rejects.toThrow()
    await chat.shutdown()
  })
  test('Given 未来索引版本 When 读写或snapshot Then 拒绝且不覆盖', async () => {
    const { chat, configDir } = fixture(mockFetch)
    const raw = JSON.stringify({ version: 999, conversations: [] })
    writeFileSync(join(configDir, 'conversations.json'), raw)
    await expect(chat.operation(C.CREATE_CONVERSATION, [])).rejects.toThrow('版本')
    expect(() => chat.snapshot()).toThrow('版本')
    expect(readFileSync(join(configDir, 'conversations.json'), 'utf8')).toBe(raw)
    await chat.shutdown()
  })
  test('Given 不同config When 相同ID查询 Then 不越界读取', async () => {
    const a = fixture(mockFetch); const b = fixture(mockFetch); const meta = await create(a.chat)
    await expect(b.chat.operation(C.GET_MESSAGES, [meta.id])).rejects.toThrow('不存在')
    await a.chat.shutdown(); await b.chat.shutdown()
  })
  test('Given 活跃流 When 停止/关闭 Then 等待部分回复落盘并拒绝新发送', async () => {
    const fetch = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')); init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true }) } }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof globalThis.fetch
    const { chat } = fixture(fetch); const meta = await create(chat)
    await chat.operation(C.SEND_MESSAGE, [input(meta.id)])
    await expect(chat.operation(C.SEND_MESSAGE, [{ ...input(meta.id), runId: 'run-2' }])).rejects.toThrow('正在生成')
    await Bun.sleep(20)
    await chat.operation(C.STOP_GENERATION, [meta.id]); await settled(chat)
    expect((await chat.operation(C.GET_BRANCH, [meta.id]) as Array<{ content: string }>).at(-1)?.content).toBe('partial')
    await chat.shutdown(); await expect(chat.operation(C.SEND_MESSAGE, [input(meta.id)])).rejects.toThrow('关闭')
  })
})
