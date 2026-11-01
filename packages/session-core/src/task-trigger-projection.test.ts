import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKSystemMessage } from '@profer/shared'
import { buildNavigationEntries, getGroupPreview, groupIntoTurns, readSessionMessagesFromString, renderTranscriptMarkdown, searchTurns, toTranscript } from './index'

const text = `可信来源：定时任务触发。${'保留完整来源说明。'.repeat(30)}`
const provenance = {
  schemaVersion: 1,
  messageId: 'notice-1',
  author: { type: 'automation', id: 'daily' },
  runId: 'run-1',
  taskId: 'task-1',
  triggerId: 'daily:occurrence-1',
  source: { type: 'automation', id: 'daily' },
} as const
const notice: SDKSystemMessage = {
  type: 'system', subtype: 'task_trigger', uuid: 'notice-1', _createdAt: 100,
  message: text, _provenance: provenance,
}
const assistant = (value: string): SDKMessage => ({
  type: 'assistant', uuid: value, parent_tool_use_id: null,
  message: { model: 'same-model', content: [{ type: 'text', text: value }] },
})

describe('task_trigger 来源通知投影', () => {
  test('新运行来源独立成组并阻断两侧同模型 turn 合并，只有 preview 截断', () => {
    const messages = readSessionMessagesFromString([assistant('before'), notice, assistant('after')].map((message) => JSON.stringify(message)).join('\n'))
    const groups = groupIntoTurns(messages)
    expect(groups.map((group) => group.type)).toEqual(['assistant-turn', 'system', 'assistant-turn'])
    expect(getGroupPreview(groups[1]!)).toBe(text.slice(0, 200))
    const turns = toTranscript(groups)
    expect(turns[1]).toMatchObject({ role: 'system', text, createdAt: 100, author: provenance.author, provenance })
    expect(searchTurns(turns, '定时任务触发')[0]).toMatchObject({ role: 'system', author: provenance.author, provenance })
    const markdown = renderTranscriptMarkdown(turns, { header: false })
    expect(markdown).toContain(text)
    expect(markdown).toContain('来源作者: automation (daily)')
    expect(markdown).not.toContain('undefined')
  })

  test('导航保留产品 uuid、status role 与可读消息，缺失 provenance 不猜作者', () => {
    expect(buildNavigationEntries([notice])).toEqual([{
      id: 'notice-1', role: 'status', preview: text.slice(0, 200),
      model: undefined, matchKey: 'status:task_trigger:100',
    }])
    const legacyNotice = { ...notice, _provenance: undefined }
    expect(toTranscript(groupIntoTurns([legacyNotice]))[0]?.author).toEqual({ type: 'unknown' })
  })
})
