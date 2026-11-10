import { expect, test } from 'bun:test'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { createClaudeSdkDouble } from '../test-hosts/claude-sdk-double'

for (const change of ['stop', 'replace', 'invalidate'] as const) {
  test(`真实 Claude adapter：ready 等待期间 ${change} 不得入队`, async () => {
    const double = createClaudeSdkDouble()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let loading!: () => void
    const started = new Promise<void>(resolve => { loading = resolve })
    let loads = 0
    const adapter = new ClaudeAgentAdapter({
      sdkLoader: async () => { if (++loads === 1) { loading(); await gate }; return double.module },
      spawnProcess: double.spawnProcess,
    })
    const input = { sessionId: 'ready-generation', prompt: 'fixture', sdkCliPath: '/unused/mock', env: {}, sdkPermissionMode: 'auto' as const, allowDangerouslySkipPermissions: false, systemPrompt: 'test' }
    const first = adapter.query(input)[Symbol.asyncIterator]()
    const pending = first.next()
    await started
    let current = true
    const sending = adapter.sendQueuedMessage(input.sessionId, {
      type: 'user', message: { role: 'user', content: 'must not deliver' },
      parent_tool_use_id: null, session_id: input.sessionId,
    }, { isCurrent: () => current })
    // 立刻安装 rejection handler，避免 fixture 清理期间未处理拒绝。
    const result = sending.then(() => 'accepted', () => 'rejected')
    let replacement: Promise<IteratorResult<unknown>> | undefined
    if (change === 'stop') adapter.abort(input.sessionId)
    if (change === 'replace') replacement = adapter.query(input)[Symbol.asyncIterator]().next()
    if (change === 'invalidate') current = false
    release()
    try {
      expect(await result).toBe('rejected')
    } finally {
      double.end()
      await pending
      await replacement
      adapter.dispose()
      double.dispose()
    }
  })
}
