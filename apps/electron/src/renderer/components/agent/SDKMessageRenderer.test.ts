import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { groupIntoTurns, getGroupPreview } from './SDKMessageRenderer'

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

describe('harness_follow_up 系统消息渲染分组', () => {
  test('验证兜底系统消息独立成组并阻断前后同模型 turn 合并', () => {
    const groups = groupIntoTurns([
      userText('修复类型报错'),
      assistantText('开始修改'),
      systemMessage('harness_follow_up', { pending_paths: ['src/a.ts'] }),
      assistantText('验证通过'),
    ])
    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system', 'assistant-turn'])
  })

  test('验证兜底系统消息提供预览文案（迷你地图/outline 用）', () => {
    const groups = groupIntoTurns([
      userText('修复类型报错'),
      assistantText('开始修改'),
      systemMessage('harness_follow_up', { pending_paths: ['src/a.ts'] }),
      assistantText('验证通过'),
    ])
    const systemGroup = groups.find((group) => group.type === 'system')
    expect(systemGroup).toBeDefined()
    expect(getGroupPreview(systemGroup!)).toBe('系统验证兜底：已自动复查未验证改动')
  })

  test('其他 system 消息分组行为不变', () => {
    const groups = groupIntoTurns([
      userText('修复类型报错'),
      assistantText('开始修改'),
      systemMessage('compact_boundary'),
      assistantText('验证通过'),
    ])
    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system', 'assistant-turn'])
  })
})
