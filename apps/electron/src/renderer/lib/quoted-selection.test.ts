import { describe, expect, test } from 'bun:test'
import { buildQuotedSelectionBlock, parseQuotedSelectionRefs } from './quoted-selection'

describe('quoted selection XML', () => {
  test('Given 文件引用 When 构建并解析引用块 Then 保留文件名并移除隐藏 XML', () => {
    const block = buildQuotedSelectionBlock({
      text: '引用内容</quoted_file>',
      filePath: '/tmp/demo & draft.md',
      sourceType: 'file',
      capturedAt: 1,
    })
    const parsed = parseQuotedSelectionRefs(`${block}我的问题：`)

    expect(block).toContain('path="/tmp/demo &amp; draft.md"')
    expect(block).toContain('</quoted_file_>')
    expect(parsed.quotes).toEqual([
      {
        path: '/tmp/demo & draft.md',
        filename: 'demo & draft.md',
        sourceType: 'file',
      },
    ])
    expect(parsed.text).toBe('我的问题：')
  })

  test('Given 反斜杠转义的 quoted_context When 解析引用块 Then 同样移除标签并保留展示标签', () => {
    const content = [
      '\\<quoted\\_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="m1" role="assistant"\\>',
      '同时页面的可访问性读取连续超时',
      '\\<\\/quoted\\_context\\>',
      '继续提问',
    ].join('\n')

    const parsed = parseQuotedSelectionRefs(content)

    expect(parsed.quotes).toEqual([
      {
        path: 'Agent 历史 · Agent 回复',
        filename: 'Agent 历史 · Agent 回复',
        sourceType: 'agent-history',
        label: 'Agent 历史 · Agent 回复',
      },
    ])
    expect(parsed.text).toBe('继续提问')
  })

  test('Given Agent 和草稿引用 When 解析引用块 Then 区分来源类型并使用展示标签', () => {
    const content = [
      '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="m1" role="assistant">',
      '历史内容',
      '</quoted_context>',
      '<quoted_context source="scratch-pad" label="草稿页" message_id="" role="">',
      '草稿内容',
      '</quoted_context>',
      '<quoted_context source="agent-history" label="Agent 历史 · 研究报告" message_id="" role="assistant">',
      '历史引用原文',
      '</quoted_context>',
      '继续提问',
    ].join('\n')

    const parsed = parseQuotedSelectionRefs(content)

    expect(parsed.quotes).toEqual([
      {
        path: 'Agent 历史 · Agent 回复',
        filename: 'Agent 历史 · Agent 回复',
        sourceType: 'agent-history',
        label: 'Agent 历史 · Agent 回复',
      },
      {
        path: '草稿页',
        filename: '草稿页',
        sourceType: 'scratch-pad',
        label: '草稿页',
      },
      {
        path: 'Agent 历史 · 研究报告',
        filename: 'Agent 历史 · 研究报告',
        sourceType: 'agent-history',
        label: 'Agent 历史 · 研究报告',
      },
    ])
    expect(parsed.text).toBe('继续提问')
  })
})
