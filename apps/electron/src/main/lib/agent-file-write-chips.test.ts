/**
 * 消息气泡里的文件改动 chip：账本与挂载点。
 *
 * 旧链靠 orchestrator 里的 `fileWritesByToolUse`；新链缺这段，chip 与历史回放都丢了。
 */
import { describe, expect, test } from 'bun:test'
import { createFileWriteChipLedger } from './agent-file-write-chips'
import type { SDKMessage } from '@profer/shared'

function toolResultMessage(toolUseId: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  } as unknown as SDKMessage
}

function blocksOf(message: SDKMessage): Array<Record<string, unknown>> {
  return (message as unknown as { message: { content: Array<Record<string, unknown>> } }).message.content
}

describe('文件改动 chip 账本', () => {
  test('受控写入挂到对应 tool_result 上', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    const attached = ledger.attach('s1', toolResultMessage('tool-1'))
    expect(blocksOf(attached)[0]!.proferFileChanges).toEqual([{ path: '/w/a.md', source: 'write' }])
  })

  test('没有命中时返回原对象，不制造形状漂移', () => {
    const ledger = createFileWriteChipLedger()
    const message = toolResultMessage('tool-unknown')
    expect(ledger.attach('s1', message)).toBe(message)
  })

  test('同一事实只挂一次（重复转发不掉字段也不重复）', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    const first = ledger.attach('s1', toolResultMessage('tool-1'))
    const second = ledger.attach('s1', toolResultMessage('tool-1'))
    expect(blocksOf(first)[0]!.proferFileChanges).toHaveLength(1)
    expect(second).not.toHaveProperty('message.content.0.proferFileChanges')
  })

  test('同一工具调用写同一路径只记一次，不同路径都保留', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    ledger.record('s1', 'tool-1', { path: '/w/b.md', source: 'edit' })
    const attached = ledger.attach('s1', toolResultMessage('tool-1'))
    expect(blocksOf(attached)[0]!.proferFileChanges).toEqual([
      { path: '/w/a.md', source: 'write' },
      { path: '/w/b.md', source: 'edit' },
    ])
  })

  test('会话之间不串账', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    const message = toolResultMessage('tool-1')
    expect(ledger.attach('s2', message)).toBe(message)
  })

  test('非 user 消息与无块消息原样返回', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as unknown as SDKMessage
    expect(ledger.attach('s1', assistant)).toBe(assistant)
    const plain = { type: 'user', message: { content: 'text' } } as unknown as SDKMessage
    expect(ledger.attach('s1', plain)).toBe(plain)
  })

  test('dropSession 清掉未消费的事实', () => {
    const ledger = createFileWriteChipLedger()
    ledger.record('s1', 'tool-1', { path: '/w/a.md', source: 'write' })
    ledger.dropSession('s1')
    const message = toolResultMessage('tool-1')
    expect(ledger.attach('s1', message)).toBe(message)
  })

  test('失败轮次不会让单会话账本无界增长', () => {
    const ledger = createFileWriteChipLedger()
    for (let index = 0; index < 300; index += 1) {
      ledger.record('s1', `tool-${index}`, { path: `/w/${index}.md`, source: 'write' })
    }
    // 最早的条目被挤掉，最新的一定还在。
    const oldest = toolResultMessage('tool-0')
    expect(ledger.attach('s1', oldest)).toBe(oldest)
    expect(blocksOf(ledger.attach('s1', toolResultMessage('tool-299')))[0]!.proferFileChanges).toHaveLength(1)
  })
})
