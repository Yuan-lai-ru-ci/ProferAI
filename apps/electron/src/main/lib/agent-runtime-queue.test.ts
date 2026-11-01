import { describe, expect, test } from 'bun:test'
import { AgentRunLedger, AgentRuntimeCoordinator, createInMemoryRunLedgerPort, type AgentRunOutcome } from '@profer/agent-runtime'
import type { SDKMessage, SDKUserMessageInput } from '@profer/shared'
import { queueRuntimeUserMessage } from './agent-runtime-queue'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('新运行链追加消息组合', () => {
  test.each(['claude', 'pi'] as const)('Given %s 已运行 When 接收重复追加并停止 Then 只落一次且保留原Run与用户作者', async runtime => {
    const port = createInMemoryRunLedgerPort()
    const ledger = new AgentRunLedger(port)
    const ready = deferred<void>()
    const done = deferred<AgentRunOutcome>()
    const messages: SDKMessage[] = []
    const received: SDKUserMessageInput[] = []
    const calls: string[] = []
    const coordinator = new AgentRuntimeCoordinator({ runLedger: ledger, adapters: { [runtime]: { runtime, query: async () => { ready.resolve(); return done.promise }, stop: () => { done.resolve({ status: 'stopped' }) } } }, ports: { sessions: { getMeta: () => undefined, updateMeta() {}, appendMessages: (_id, values) => { messages.push(...values) } } } })
    const handle = coordinator.run({ sessionId: 's', runtime, prompt: '任务' }, { onEvent() {} })
    await ready.promise
    const queued = { sessionId: 's', userMessage: '模型提示', rawUserMessage: '用户原文', uuid: 'queue', interrupt: true }
    const deps = { runtime, queue: coordinator.queueMessage.bind(coordinator), enrich: () => '引用\n模型提示', interrupt: async () => { calls.push('interrupt') }, send: async (_id: string, message: SDKUserMessageInput) => { calls.push('send'); received.push(message) } }
    expect(await queueRuntimeUserMessage(queued, deps)).toBe('queue')
    expect(await queueRuntimeUserMessage(queued, deps)).toBe('queue')
    expect(received).toHaveLength(1)
    expect(calls).toEqual(runtime === 'claude' ? ['interrupt', 'send'] : ['send'])
    expect(received[0]?.message.content).toBe('引用\n模型提示')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ uuid: 'queue', _provenance: { author: { type: 'user' }, runId: ledger.list()[0]!.id }, message: { content: [{ text: '用户原文' }] } })
    expect(port.load().events.filter(event => event.type === 'input_attached')).toHaveLength(1)
    expect(ledger.list()).toHaveLength(1)
    await handle.stop()
    expect(await handle.promise).toEqual({ status: 'stopped' })
    await expect(queueRuntimeUserMessage({ ...queued, uuid: 'late' }, deps)).rejects.toThrow('未运行')
    expect(received).toHaveLength(1)
  })
  test('Given 接收前会话已经settled When 构造追加 Then 不调用Provider', async () => {
    let sent = false
    await expect(queueRuntimeUserMessage({ sessionId: 's', userMessage: 'x' }, { runtime: 'pi', queue: async input => { await input.receive({ message: input.message, isCurrent: () => false }); return { messageId: 'x' } }, send: async () => { sent = true } })).rejects.toThrow('未运行')
    expect(sent).toBe(false)
  })
})
