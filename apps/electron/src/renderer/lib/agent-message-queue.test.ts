import { describe, expect, test } from 'bun:test'
import { buildQueuedMessageSendPayload, createAgentQueuedMessage, discardQueuedMessagesOnStop, isQueueTargetNoLongerActiveError, shouldRestoreQueuedMessageAfterFailure } from './agent-message-queue'
import { buildQuotedSelectionBlock } from './quoted-selection'
import type { QuotedSelection } from '@/atoms/preview-atoms'

describe('queue target lifecycle errors', () => {
  test('仅将主进程明确的“会话未运行”错误视为可恢复的 inject-or-start 竞态', () => {
    expect(isQueueTargetNoLongerActiveError(new Error('[Agent 编排] 会话未运行，无法追加消息: session-1'))).toBe(true)
    expect(isQueueTargetNoLongerActiveError(new Error('当前活跃 Agent runtime 不支持追加消息'))).toBe(false)
    expect(isQueueTargetNoLongerActiveError(new Error('[Agent 编排] 会话正在停止，无法追加消息: session-1'))).toBe(false)
    expect(isQueueTargetNoLongerActiveError('会话未运行，无法追加消息')).toBe(false)
  })

  test('Stop 丢弃已入队消息，返回独立的空队列以阻止旧消息被 drain 或立即发送', () => {
    const queued = [createAgentQueuedMessage('第一条', 'one', 1), createAgentQueuedMessage('第二条', 'two', 2)]
    const discarded = discardQueuedMessagesOnStop(queued)

    expect(discarded).toEqual([])
    expect(discarded).not.toBe(queued)
    expect(queued.map((item) => item.id)).toEqual(['one', 'two'])
  })

  test('仅在未 Stop 的同一 queue epoch 中恢复失败的 in-flight 消息', () => {
    expect(shouldRestoreQueuedMessageAfterFailure(4, 4, false)).toBe(true)
    expect(shouldRestoreQueuedMessageAfterFailure(4, 5, false)).toBe(false)
    expect(shouldRestoreQueuedMessageAfterFailure(4, 4, true)).toBe(false)
  })

  test('保留带引用选区的队列 payload 和 mention 解析', () => {
    const quotedSelection: QuotedSelection = { text: '被引用的内容', filePath: '/tmp/demo.md', capturedAt: 123 }
    const message = createAgentQueuedMessage('继续解释 /skill:writer #mcp:docs &session:abc', 'queued-1', 456, quotedSelection)
    const payload = buildQueuedMessageSendPayload(message, buildQuotedSelectionBlock(quotedSelection))

    expect(payload.rawText).toContain('<quoted_file path="/tmp/demo.md">')
    expect(payload.rawText).toContain('继续解释 /skill:writer #mcp:docs &session:abc')
    expect(payload.sdkText).toContain('继续解释')
    expect(payload.sdkText).not.toContain('/skill:writer')
    expect(payload.mentions).toEqual({ cleanedText: '继续解释', mentionedSkills: ['writer'], mentionedMcpServers: ['docs'], mentionedSessionIds: ['abc'] })
  })
})
