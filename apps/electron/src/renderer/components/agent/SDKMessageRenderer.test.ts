import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { groupIntoTurns, getGroupPreview, parseAttachedFiles } from './SDKMessageRenderer'

function userText(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], model: 'deepseek-v4-flash' },
  } as unknown as SDKMessage
}

function systemMessage(subtype: string, extra: Record<string, unknown> = {}): SDKMessage {
  return { type: 'system', subtype, ...extra } as unknown as SDKMessage
}

describe('用户消息引用上下文渲染', () => {
  test('quoted_context 解析为引用 chip 数据且不泄漏 XML 到正文', () => {
    const parsed = parseAttachedFiles([
      '<quoted_context source="agent-interruption" label="已被用户中断" message_id="" role="">',
      '上次任务被中断（已被用户中断，2026/8/18 16:35:33），可能未完成。',
      '</quoted_context>',
      '',
      '像这种和引用发送后到对话框里是这样的',
    ].join('\n'))

    expect(parsed.quotes).toEqual([
      {
        path: '已被用户中断',
        filename: '已被用户中断',
        sourceType: 'agent-interruption',
        label: '已被用户中断',
      },
    ])
    expect(parsed.text).toBe('像这种和引用发送后到对话框里是这样的')
  })

  test('用户消息迷你地图预览同样剥离 quoted_context', () => {
    const groups = groupIntoTurns([
      userText('<quoted_context source="agent-history" label="Agent 历史" message_id="m1" role="assistant">\n被引用内容\n</quoted_context>\n\n继续任务'),
    ])

    expect(getGroupPreview(groups[0]!)).toBe('继续任务')
  })
})

describe('system 消息渲染分组', () => {
  test('上下文压缩系统消息独立成组并阻断前后同模型 turn 合并', () => {
    const groups = groupIntoTurns([
      userText('修复类型报错'),
      assistantText('开始修改'),
      systemMessage('compact_boundary'),
      assistantText('验证通过'),
    ])
    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system', 'assistant-turn'])
  })
})
