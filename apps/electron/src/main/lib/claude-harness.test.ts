import { test, expect } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { createClaudeHarnessTracker } from './claude-harness'

/** 构造 assistant tool_use 消息 */
function toolUseMessage(name: string, input: Record<string, unknown>, opts: { id?: string; isReplay?: boolean } = {}): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: opts.id ?? 'call-1', name, input }] },
    ...(opts.isReplay ? { isReplay: true } : {}),
  } as unknown as SDKMessage
}

/** 构造 user tool_result 消息 */
function toolResultMessage(toolUseId: string, opts: { isError?: boolean; isReplay?: boolean } = {}): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', ...(opts.isError ? { is_error: true } : {}) }] },
    ...(opts.isReplay ? { isReplay: true } : {}),
  } as unknown as SDKMessage
}

/** 构造终态 result 消息 */
function terminalResult(overrides: { subtype?: string; terminal_reason?: string } = {}): SDKMessage {
  return { type: 'result', subtype: 'success', ...overrides } as unknown as SDKMessage
}

test('Given Claude 写入后未验证 When 正常终态 Then 产出 follow-up 提示并列出未验证文件', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修复 parser 的类型报错' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/example.ts' }))
  tracker.observeMessage(toolResultMessage('call-1'))
  const prompt = tracker.evaluateTerminalResult(terminalResult())
  expect(prompt).toContain('最小验证')
  expect(prompt).toContain('src/example.ts')
  expect(tracker.createDecision().action).toBe('follow_up')
})

test('Given 写入失败（is_error）When 终态 Then 不计入变更且不触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }))
  tracker.observeMessage(toolResultMessage('call-1', { isError: true }))
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('read_only')
})

test('Given 写入后被 Read 回读 When 终态 Then 视为已验证不触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '改一处 TypeScript' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }, { id: 'w-1' }))
  tracker.observeMessage(toolResultMessage('w-1'))
  tracker.observeMessage(toolUseMessage('Read', { file_path: 'src/a.ts' }, { id: 'r-1' }))
  tracker.observeMessage(toolResultMessage('r-1'))
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('validated')
})

test('Given 写入后运行验证语义 Bash When 终态 Then 视为已尝试验证不触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }, { id: 'w-1' }))
  tracker.observeMessage(toolResultMessage('w-1'))
  tracker.observeMessage(toolUseMessage('Bash', { command: 'bunx tsc --noEmit' }, { id: 'b-1' }))
  tracker.observeMessage(toolResultMessage('b-1'))
  const decision = tracker.createDecision()
  expect(decision.validationAttempted).toBe(true)
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
})

test('Given 错误类结果 When 终态 Then 标记失败不触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }))
  tracker.observeMessage(toolResultMessage('call-1'))
  expect(tracker.evaluateTerminalResult(terminalResult({ subtype: 'error_during_execution' }))).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('blocked_or_failed')
})

test('Given max_turns 终态 When 评估 Then 标记失败不触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }))
  tracker.observeMessage(toolResultMessage('call-1'))
  expect(tracker.evaluateTerminalResult(terminalResult({ terminal_reason: 'max_turns' }))).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('blocked_or_failed')
})

test('Given 用户软中断 result When 之后正常终态 Then 与 Pi 对齐不再触发 follow-up', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(terminalResult({ terminal_reason: 'aborted_streaming' }))
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }, { id: 'w-1' }))
  tracker.observeMessage(toolResultMessage('w-1'))
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('blocked_or_failed')
})

test('Given resume 回放消息（isReplay）When 观察 Then 全部忽略不产生跟踪事实', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '继续任务' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/old.ts' }, { id: 'w-replay', isReplay: true }))
  tracker.observeMessage(toolResultMessage('w-replay', { isReplay: true }))
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('read_only')
})

test('Given 只有 tool_use 没有 tool_result When 终态 Then 不视为已确认写入（无结果即无事实）', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修改代码' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/a.ts' }))
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
  expect(tracker.createDecision().reason).toBe('read_only')
})

test('Given follow-up 已触发一次 When 再次评估终态 Then 不重复触发', () => {
  const tracker = createClaudeHarnessTracker({ userPrompt: '修复 parser 的类型报错' })
  tracker.observeMessage(toolUseMessage('Write', { file_path: 'src/example.ts' }))
  tracker.observeMessage(toolResultMessage('call-1'))
  expect(tracker.evaluateTerminalResult(terminalResult())).toContain('最小验证')
  expect(tracker.evaluateTerminalResult(terminalResult())).toBeUndefined()
})
