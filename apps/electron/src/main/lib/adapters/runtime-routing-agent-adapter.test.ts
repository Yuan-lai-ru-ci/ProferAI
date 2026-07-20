import { describe, expect, test } from 'bun:test'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@profer/shared'
import { RuntimeRoutingAgentAdapter } from './runtime-routing-agent-adapter'

function createAdapter(calls: string[], errorPrefix = ''): AgentProviderAdapter {
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
    dispose() { calls.push('dispose') },
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

  test('Given Pi runtime When resolving error helpers Then returns Pi helpers instead of Claude helpers', () => {
    const router = new RuntimeRoutingAgentAdapter({
      claude: createAdapter([], 'claude:'),
      pi: createAdapter([], 'pi:'),
    })
    expect(router.getErrorHelpers('pi').friendlyErrorMessage('failure')).toBe('pi:failure')
  })
})
