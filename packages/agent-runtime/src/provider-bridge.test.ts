import { describe, expect, test } from 'bun:test'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@profer/shared'
import { AgentRuntimeCoordinator } from './coordinator'
import { createAgentRuntimeProviderAdapter } from './provider-bridge'

const message = { type: 'result', subtype: 'success' } as unknown as SDKMessage

function provider(query: (input: AgentQueryInput) => AsyncIterable<SDKMessage>, abort: (sessionId: string) => void): AgentProviderAdapter {
  return {
    query,
    abort,
    dispose() {},
    errorHelpers: {} as AgentProviderAdapter['errorHelpers'],
  }
}

describe('runtime provider bridge', () => {
  test('maps runtime query into shared provider input and drives it through coordinator', async () => {
    const calls: AgentQueryInput[] = []
    const adapter = createAgentRuntimeProviderAdapter('pi', provider(input => {
      calls.push(input)
      return (async function* () {
        yield { type: 'assistant', message: { content: [] } } as never
        yield message
      })()
    }, () => {}))
    const messages: unknown[] = []
    const coordinator = new AgentRuntimeCoordinator({
      adapters: { pi: adapter },
      ports: { sessions: { getMeta: () => undefined, appendMessages: (_id, next) => { messages.push(...next) }, updateMeta: () => undefined } },
    })

    await expect(coordinator.run({ sessionId: 'bridge-session', runtime: 'pi', prompt: 'hello', modelId: 'model-1', cwd: '/tmp', isolatedRuntimeSession: true }).promise)
      .resolves.toEqual({ status: 'completed' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'bridge-session',
      prompt: 'hello',
      model: 'model-1',
      agentRuntime: 'pi',
      isolatedRuntimeSession: true,
      cwd: '/tmp',
    })
    expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(messages).toHaveLength(2)
  })

  test('forwards explicit providerInput alongside runtime-neutral fields', async () => {
    let received: AgentQueryInput | undefined
    const adapter = createAgentRuntimeProviderAdapter('pi', provider(input => {
      received = input
      return (async function* () { yield message })()
    }, () => {}))
    const coordinator = new AgentRuntimeCoordinator({ adapters: { pi: adapter } })
    await expect(coordinator.run({ sessionId: 'provider-input', runtime: 'pi', prompt: 'fixture', providerInput: { provider: 'deepseek', apiKey: 'redacted' } }).promise)
      .resolves.toEqual({ status: 'completed' })
    expect(received).toMatchObject({ provider: 'deepseek', apiKey: 'redacted', sessionId: 'provider-input', prompt: 'fixture' })
  })
  for (const runtime of ['claude', 'pi'] as const) {
    test(`${runtime}: late cleanup of attempt A preserves attempt B for stop`, async () => {
      const releases: Array<() => void> = []
      const aborted: string[] = []
      const adapter = createAgentRuntimeProviderAdapter(runtime, provider(() => {
        const pending = new Promise<void>(resolve => { releases.push(resolve) })
        return (async function* () { await pending })()
      }, sessionId => { aborted.push(sessionId) }))
      const input = { sessionId: 'overlapping-session', runtime, prompt: 'wait' }
      const first = adapter.stream!(input)[Symbol.asyncIterator]()
      const firstDone = first.next()
      await adapter.stop?.('user', input.sessionId)
      const second = adapter.stream!(input)[Symbol.asyncIterator]()
      const secondDone = second.next()
      releases[0]!()
      await firstDone
      try {
        await adapter.stop?.('user', input.sessionId)
        expect(aborted).toEqual([input.sessionId, input.sessionId])
      } finally {
        releases[1]!()
        await secondDone
      }
      await adapter.stop?.('user', input.sessionId)
      expect(aborted).toHaveLength(2)
    })
  }

  test('logical stopped retains provider resource lease until background iterator actually drains', async () => {
    let release!: () => void
    let ready!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    const adapter = createAgentRuntimeProviderAdapter('pi', provider(() => (async function* () {
      ready()
      await pending
    })(), () => {}))
    const coordinator = new AgentRuntimeCoordinator({ stopDeadlineMs: 5, adapters: { pi: adapter } })
    const input = { sessionId: 'late-resource', runtime: 'pi' as const, prompt: 'wait' }
    const handle = coordinator.run(input)
    await started
    try {
      await coordinator.stop(input.sessionId)
      await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
      expect(coordinator.isRunning(input.sessionId)).toBe(true)
      expect(coordinator.ownership.isOwned(input.sessionId)).toBe(true)
      await expect(coordinator.run(input).promise).rejects.toThrow()
      await expect(coordinator.stopAndWait(input.sessionId)).rejects.toMatchObject({ code: 'AGENT_RUNTIME_STOP_TIMEOUT' })
    } finally { release() }
    await adapter.waitForDrain!(input.sessionId)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(coordinator.isRunning(input.sessionId)).toBe(false)
    expect(coordinator.ownership.isOwned(input.sessionId)).toBe(false)
  })

  test('routes coordinator stop to the active provider session and closes its stream', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let aborted = ''
    const adapter = createAgentRuntimeProviderAdapter('claude', provider(() => ({
      async *[Symbol.asyncIterator]() {
        try {
          await pending
        } finally {
          release()
        }
      },
    }), sessionId => { aborted = sessionId; release() }))
    const coordinator = new AgentRuntimeCoordinator({ adapters: { claude: adapter } })
    const handle = coordinator.run({ sessionId: 'stop-session', runtime: 'claude', prompt: 'wait' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await handle.stop()

    await expect(handle.promise).resolves.toEqual({ status: 'stopped' })
    expect(aborted).toBe('stop-session')
  })
})
