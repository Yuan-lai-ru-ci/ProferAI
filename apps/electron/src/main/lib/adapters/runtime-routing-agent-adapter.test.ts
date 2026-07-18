import { describe, expect, test } from 'bun:test'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage } from '@profer/shared'
import { RuntimeRoutingAgentAdapter } from './runtime-routing-agent-adapter'

function createAdapter(calls: string[]): AgentProviderAdapter {
  return {
    async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
      calls.push(`query:${input.sessionId}`)
    },
    abort(sessionId) { calls.push(`abort:${sessionId}`) },
    dispose() { calls.push('dispose') },
    errorHelpers: {
      friendlyErrorMessage: value => value,
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
    for await (const _ of router.query({ sessionId: 'claude-session', prompt: 'hi', agentRuntime: 'claude' })) {}
    router.abort('claude-session')
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
})
