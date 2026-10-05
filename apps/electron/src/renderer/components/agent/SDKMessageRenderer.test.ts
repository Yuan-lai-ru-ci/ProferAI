import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKMessage } from '@profer/shared'
import { groupIntoTurns, getGroupPreview, getLatestUserGroupId, MessageGroupRenderer, parseAttachedFiles, buildHistoricalTaskSubjects, type MessageGroup } from './SDKMessageRenderer'

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

  test('Skill 未加载提示独立成组，迷你地图预览显示提示原文', () => {
    const notice = { ...systemMessage('skill_routing_notice'), message: 'Skill 未加载：pptx（所需工具组已关闭）' } as unknown as SDKMessage
    const groups = groupIntoTurns([userText('/skill:pptx 做个 PPT'), notice, assistantText('好的')])
    expect(groups.map((group) => group.type)).toEqual(['user', 'system', 'assistant-turn'])
    expect(getGroupPreview(groups[1]!)).toBe('Skill 未加载：pptx（所需工具组已关闭）')
  })
})

function assistantTurn(blocks: string[][]): MessageGroup {
  return {
    type: 'assistant-turn',
    assistantMessages: blocks.map((content) => ({
      type: 'assistant',
      message: { content: content.map((text) => ({ type: 'text', text })) },
    })),
  } as unknown as MessageGroup
}

describe('assistant-turn 迷你地图预览', () => {
  test('多个 text 块按空格拼接（与 join 语义一致）', () => {
    expect(getGroupPreview(assistantTurn([['第一段'], ['第二段']]))).toBe('第一段 第二段')
  })

  test('同一消息内的多个块也按空格拼接', () => {
    expect(getGroupPreview(assistantTurn([['甲', '乙']]))).toBe('甲 乙')
  })

  test('空文本块保持 join 的前导空格语义', () => {
    expect(getGroupPreview(assistantTurn([[''], ['内容']]))).toBe(' 内容')
  })

  test('超过 200 字符时截断到 200，并保留块间空格', () => {
    const first = 'A'.repeat(150)
    const preview = getGroupPreview(assistantTurn([[first], ['B'.repeat(100)]]))
    expect(preview.length).toBe(200)
    expect(preview).toBe(`${first} ${'B'.repeat(49)}`)
  })

  test('无 text 块时返回空字符串', () => {
    expect(getGroupPreview(assistantTurn([[]]))).toBe('')
  })
})

function taskCreateMessage(toolUseId: string, input: Record<string, unknown>): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'TaskCreate', input }], model: 'test-model' },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function toolResultMessage(toolUseId: string, content: unknown, structured?: unknown): SDKMessage {
  const message: Record<string, unknown> = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    parent_tool_use_id: null,
  }
  if (structured !== undefined) message.tool_use_result = structured
  return message as unknown as SDKMessage
}

describe('buildHistoricalTaskSubjects', () => {
  test('优先从结构化 tool_use_result 读取 task.id 与 task.subject', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底标题' }),
      toolResultMessage('tu1', 'ok', { task: { id: '7', subject: '真实标题' } }),
    ])
    expect(map.get('7')).toBe('真实标题')
  })

  test('结构化结果缺 subject 时回退到 TaskCreate input 的 subject', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底标题' }),
      toolResultMessage('tu1', 'ok', { task: { id: '9' } }),
    ])
    expect(map.get('9')).toBe('兜底标题')
  })

  test('先用 description 作兜底，再回退到 input.subject', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { description: '描述兜底' }),
      toolResultMessage('tu1', 'ok', { task: { id: '10' } }),
    ])
    expect(map.get('10')).toBe('描述兜底')
  })

  test('无结构化结果时回退解析 tool_result 文本', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底' }),
      toolResultMessage('tu1', '{"task":{"id":"11","subject":"文本标题"}}'),
    ])
    expect(map.get('11')).toBe('文本标题')
  })

  test('结构化结果内嵌 content block 数组时仍可解析', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底' }),
      toolResultMessage('tu1', 'ok', { content: [{ type: 'text', text: '{"task":{"id":"13"}}' }] }),
    ])
    expect(map.get('13')).toBe('兜底')
  })

  test('旧格式文本兜底（Task #N created successfully）', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底' }),
      toolResultMessage('tu1', 'Task #21 created successfully'),
    ])
    expect(map.get('21')).toBe('兜底')
  })

  test('缺 subject/description 的 TaskCreate 不产生映射', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', {}),
      toolResultMessage('tu1', 'ok', { task: { id: '5', subject: 'x' } }),
    ])
    expect(map.size).toBe(0)
  })

  test('与 TaskCreate 无关的 tool_result 不参与解析', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: '兜底' }),
      toolResultMessage('other', 'ok', { task: { id: '99', subject: '不该出现' } }),
    ])
    expect(map.size).toBe(0)
  })

  test('多个 TaskCreate 按顺序映射，结果互不干扰', () => {
    const map = buildHistoricalTaskSubjects([
      taskCreateMessage('tu1', { subject: 'A' }),
      taskCreateMessage('tu2', { subject: 'B' }),
      toolResultMessage('tu1', 'ok', { task: { id: '1', subject: '甲' } }),
      toolResultMessage('tu2', 'ok', { task: { id: '2' } }),
    ])
    expect(map.get('1')).toBe('甲')
    expect(map.get('2')).toBe('B')
  })
})

describe('最后一条用户消息定位（重新生成入口挂载点）', () => {
  function userWithUuid(text: string, uuid: string): SDKMessage {
    return {
      type: 'user',
      uuid,
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
  }

  test('返回最后一条真实用户消息的 group id，忽略其后的 assistant turn', () => {
    const groups = groupIntoTurns([
      userWithUuid('第一条', 'u1'),
      assistantText('回复一'),
      userWithUuid('第二条', 'u2'),
      assistantText('回复二'),
    ])
    expect(getLatestUserGroupId(groups)).toBe('u2')
  })

  test('Goal 自动迭代分隔条不计入用户发言', () => {
    const goalIteration = {
      type: 'user',
      uuid: 'goal-1',
      _goalIteration: 2,
      message: { content: [{ type: 'text', text: '继续' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const groups = groupIntoTurns([
      userWithUuid('真实发言', 'u1'),
      assistantText('回复'),
      goalIteration,
    ])
    expect(getLatestUserGroupId(groups)).toBe('u1')
  })

  test('没有用户消息时返回 undefined', () => {
    expect(getLatestUserGroupId(groupIntoTurns([assistantText('只有回复')]))).toBeUndefined()
  })
})

describe('最后一条用户消息的重新生成入口渲染', () => {
  function renderUserGroup(onRegenerate?: () => void): string {
    const message = {
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: '帮我改成 TypeScript' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const groups = groupIntoTurns([message])
    return renderToStaticMarkup(
      React.createElement(
        Provider,
        { store: createStore() },
        React.createElement(MessageGroupRenderer, {
          group: groups[0]!,
          allMessages: [],
          historicalTaskSubjects: new Map<string, string>(),
          ...(onRegenerate ? { onRegenerateLastUserMessage: onRegenerate } : {}),
        }),
      ),
    )
  }

  test('传入重新生成回调时渲染入口', () => {
    expect(renderUserGroup(() => {})).toContain('重新生成')
  })

  test('非最后一条用户消息（无回调）不渲染入口', () => {
    expect(renderUserGroup()).not.toContain('重新生成')
  })
})
