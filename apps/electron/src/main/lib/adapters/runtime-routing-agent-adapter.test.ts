import { describe, expect, test } from 'bun:test'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@profer/shared'
import { RuntimeRoutingAgentAdapter } from './runtime-routing-agent-adapter'

function createAdapter(calls: string[], errorPrefix = '', capabilities?: Partial<ReturnType<NonNullable<AgentProviderAdapter['getCapabilities']>>>): AgentProviderAdapter {
  return {
    async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
      calls.push(`query:${input.sessionId}`)
      yield { type: 'system' } as SDKMessage
      await new Promise<void>(() => {})
    },
    abort(sessionId) { calls.push(`abort:${sessionId}`) },
    async sendQueuedMessage(sessionId, _message, options) {
      calls.push(`queue:${sessionId}:${options?.interrupt ?? false}`)
    },
    async getTaskOutput(sessionId, taskId) {
      calls.push(`output:${sessionId}:${taskId}`)
      return { output: 'done', isComplete: true, status: 'completed' }
    },
    async stopTask(sessionId, taskId, expectedType) {
      if (expectedType === 'shell') throw new Error('类型不匹配')
      calls.push(`task-stop:${sessionId}:${taskId}`)
    },
    dispose() { calls.push('dispose') },
    ...(capabilities ? { getCapabilities: () => ({
      supportsTaskOutput: false,
      supportsTaskStop: false,
      supportsRewind: false,
      supportsInterrupt: false,
      supportsQueuedMessage: false,
      supportsBackgroundWakeup: false,
      supportsNativeMcp: false,
      supportsSubAgents: false,
      ...capabilities,
    }) } : {}),
    errorHelpers: {
      friendlyErrorMessage: value => `${errorPrefix}${value}`,
      isPromptTooLongError: () => false,
      isThinkingSignatureError: () => false,
      mapSDKErrorToTypedError: () => ({ code: 'unknown_error', title: 'error', message: 'error', recoverable: false, canRetry: false, actions: [] }),
      extractErrorDetails: () => ({ detailedMessage: '', originalError: '' }),
      shouldKeepChannelOpen: () => false,
    },
  }
}

describe('RuntimeRoutingAgentAdapter', () => {
  test('Given only a Claude adapter When a Claude session runs Then routes stop to the same adapter', async () => {
    const calls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter(calls) })
    const iterator = router.query({ sessionId: 'claude-session', prompt: 'hi', agentRuntime: 'claude' })[Symbol.asyncIterator]()
    await iterator.next()
    router.abort('claude-session')
    await iterator.return?.()
    expect(calls).toEqual(['query:claude-session', 'abort:claude-session'])
  })

  test('Given no Pi adapter When a Pi session runs Then returns an explicit unavailable error without invoking Claude', async () => {
    const calls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter(calls) })
    await expect(async () => {
      for await (const _ of router.query({ sessionId: 'pi-session', prompt: 'hi', agentRuntime: 'pi' })) {}
    }).toThrow('Pi Agent runtime 当前不可用')
    expect(calls).toEqual([])
  })

  test('Given an active Pi query When adding an interrupt message Then routes options only to Pi', async () => {
    const claudeCalls: string[] = []
    const piCalls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({
      claude: createAdapter(claudeCalls, 'claude:'),
      pi: createAdapter(piCalls, 'pi:'),
    })
    const iterator = router.query({ sessionId: 'pi-session', prompt: 'hi', agentRuntime: 'pi' })[Symbol.asyncIterator]()
    await iterator.next()
    await router.sendQueuedMessage('pi-session', {
      type: 'user',
      uuid: 'queued',
      session_id: 'pi-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'next' },
    }, { interrupt: true })
    await iterator.return?.()

    expect(piCalls).toEqual(['query:pi-session', 'queue:pi-session:true'])
    expect(claudeCalls).toEqual([])
  })

  test('Given an inactive session When adding a queue message Then never falls back to Claude', async () => {
    const claudeCalls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter(claudeCalls) })
    await expect(router.sendQueuedMessage('unknown', {
      type: 'user',
      uuid: 'queued',
      session_id: 'unknown',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'next' },
    })).rejects.toThrow('当前活跃 Agent runtime 不支持追加消息')
    expect(claudeCalls).toEqual([])
  })

  test('Given a completed query When reading or stopping a task Then routes through the session runtime', async () => {
    const calls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter(calls) })
    const iterator = router.query({ sessionId: 'completed-session', prompt: 'hi', agentRuntime: 'claude' })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()

    await expect(router.getTaskOutput('completed-session', 'task-1')).resolves.toMatchObject({ output: 'done' })
    await router.stopTask('completed-session', 'task-1')
    expect(calls).toContain('output:completed-session:task-1')
    expect(calls).toContain('task-stop:completed-session:task-1')
  })

  test('Given a completed query When stopping with the wrong task type Then rejects before adapter execution', async () => {
    const calls: string[] = []
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter(calls) })
    const iterator = router.query({ sessionId: 'typed-session', prompt: 'hi', agentRuntime: 'claude' })[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()

    // Router forwards the type contract; the real Claude adapter enforces the
    // same ownership/type check before invoking SDK stopTask.
    await expect(router.stopTask('typed-session', 'task-1', 'shell')).rejects.toThrow('类型不匹配')
    expect(calls).not.toContain('task-stop:typed-session:task-1')
  })

  test('Given a runtime When reading its capabilities Then reports explicit support differences', () => {
    const router = new RuntimeRoutingAgentAdapter({
      claude: createAdapter([]),
      pi: createAdapter([], '', {
        supportsTaskOutput: false,
        supportsTaskStop: false,
        supportsQueuedMessage: true,
      }),
    })
    expect(router.getRuntimeCapabilities('claude')).toMatchObject({
      available: true,
      supportsTaskOutput: true,
      supportsTaskStop: true,
      supportsBackgroundWakeup: true,
    })
    expect(router.getRuntimeCapabilities('pi')).toMatchObject({
      available: true,
      supportsTaskOutput: false,
      supportsTaskStop: false,
      supportsQueuedMessage: true,
    })
  })

  test('Given an unavailable runtime When reading capabilities Then reports unavailable without falling back', () => {
    const router = new RuntimeRoutingAgentAdapter({ claude: createAdapter([]) })
    expect(router.getRuntimeCapabilities('pi')).toMatchObject({
      runtime: 'pi',
      available: false,
      supportsTaskOutput: false,
      supportsTaskStop: false,
    })
  })

  test('Given Pi runtime When resolving error helpers Then returns Pi helpers instead of Claude helpers', () => {
    const router = new RuntimeRoutingAgentAdapter({
      claude: createAdapter([], 'claude:'),
      pi: createAdapter([], 'pi:'),
    })
    expect(router.getErrorHelpers('pi').friendlyErrorMessage('failure')).toBe('pi:failure')
  })
})
