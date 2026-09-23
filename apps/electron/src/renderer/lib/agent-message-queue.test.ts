import { describe, expect, test } from 'bun:test'
import { buildQueuedMessageSendPayload, createAgentQueuedMessage, isAgentRunAlreadyActiveError, isQueueTargetNoLongerActiveError, shouldRestoreQueuedMessageAfterFailure } from './agent-message-queue'
import { buildQuotedSelectionBlock } from './quoted-selection'
import type { QuotedSelection } from '@/atoms/preview-atoms'

describe('queue target lifecycle errors', () => {
  test('仅将主进程明确的“会话未运行”错误视为可恢复的 inject-or-start 竞态', () => {
    expect(isQueueTargetNoLongerActiveError(new Error('[Agent 编排] 会话未运行，无法追加消息: session-1'))).toBe(true)
    expect(isQueueTargetNoLongerActiveError(new Error('当前活跃 Agent runtime 不支持追加消息'))).toBe(false)
    expect(isQueueTargetNoLongerActiveError(new Error('[Agent 编排] 会话正在停止，无法追加消息: session-1'))).toBe(false)
    expect(isQueueTargetNoLongerActiveError('会话未运行，无法追加消息')).toBe(false)
  })

  test('识别同会话 owner run 仍活跃的未启动请求，包括 Electron IPC 包装', () => {
    expect(isAgentRunAlreadyActiveError(new Error('AGENT_RUN_ALREADY_ACTIVE: 上一条消息仍在处理中，请稍候再试'))).toBe(true)
    expect(isAgentRunAlreadyActiveError(new Error(
      "Error invoking remote method 'agent:send-message': Error: AGENT_RUN_ALREADY_ACTIVE: Agent 正在停止，请稍候再试",
    ))).toBe(true)
    expect(isAgentRunAlreadyActiveError(new Error('上一条消息仍在处理中，请稍候再试'))).toBe(false)
  })

  test('回归：真实 IPC 拒绝会带 Electron 包装前缀，仍必须识别为可恢复', () => {
    // ipcRenderer.invoke 会把主进程错误包成
    // "Error invoking remote method '<channel>': Error: <主进程文案>"
    const wrapped = new Error(
      "Error invoking remote method 'agent:queue-message': Error: [Agent 编排] 会话未运行，无法追加消息: session-1",
    )
    expect(isQueueTargetNoLongerActiveError(wrapped)).toBe(true)
    // 其它主进程拒绝（会话正在停止/删除）不能被误判为可恢复
    expect(isQueueTargetNoLongerActiveError(new Error(
      "Error invoking remote method 'agent:queue-message': Error: [Agent 编排] 会话正在停止，无法追加消息: session-1",
    ))).toBe(false)
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
