import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKMessage } from '@profer/shared'
import { groupIntoTurns, getGroupPreview, MessageGroupRenderer, parseAttachedFiles, buildHistoricalTaskSubjects, splitUserMessagePrefix, type MessageGroup, type EditResendRequest } from './SDKMessageRenderer'

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

function assistantTextWithModel(text: string, model: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], model },
    parent_tool_use_id: null,
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

    expect(parsed.quotes).toMatchObject([
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

  test('压缩被跳过时独立成组，预览与渲染都给出原因', () => {
    const skipText = '最近 5 分钟内已连续压缩 2 次，暂时跳过本次压缩以免反复压缩。'
    const notice = { ...systemMessage('compact_skipped'), message: skipText } as unknown as SDKMessage
    // 单独的 /compact 请求没有 assistant turn；不进断组集合的话这条提示会被分组逻辑直接丢掉。
    const groups = groupIntoTurns([notice])
    expect(groups.map((group) => group.type)).toEqual(['system'])
    expect(getGroupPreview(groups[0]!)).toBe(skipText)

    const markup = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store: createStore() },
        React.createElement(MessageGroupRenderer, {
          group: groups[0]!,
          allMessages: [notice],
          historicalTaskSubjects: new Map<string, string>(),
        }),
      ),
    )
    expect(markup).toContain(skipText)
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

describe('同一轮内的助手块合并', () => {
  test('Given 中间插入了不可见的中断记录且前后模型 id 不同 When 分组 Then 只保留一个助手块', () => {
    const groups = groupIntoTurns([
      userText('继续'),
      assistantTextWithModel('第一段', 'global:deepseek-v4.1-flash'),
      systemMessage('interruption_record'),
      assistantTextWithModel('第二段', 'cn:deepseek-v4.1-flash'),
    ])

    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'system'])
    const turn = groups[1]
    expect(turn?.type === 'assistant-turn' ? turn.assistantMessages.length : 0).toBe(2)
    // 头像取首条消息的模型，不会因为后半段换了渠道就多出一个头像
    expect(turn?.type === 'assistant-turn' ? turn.model : undefined).toBe('global:deepseek-v4.1-flash')
  })

  test('Given 真正的用户输入 When 分组 Then 仍然拆成两轮', () => {
    const groups = groupIntoTurns([
      userText('第一个问题'),
      assistantTextWithModel('答一', 'global:deepseek-v4.1-flash'),
      userText('第二个问题'),
      assistantTextWithModel('答二', 'cn:deepseek-v4.1-flash'),
    ])

    expect(groups.map((group) => group.type)).toEqual(['user', 'assistant-turn', 'user', 'assistant-turn'])
  })
})

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

describe('用户消息操作入口渲染（修改重发）', () => {
  function renderUserGroup(options: {
    onEdit?: (userMessageUuid: string) => void
    onSubmitEdit?: (request: EditResendRequest) => void
    isEditing?: boolean
    uuid?: string | undefined
    text?: string
  } = {}): string {
    const message = {
      type: 'user',
      ...(options.uuid === undefined ? { uuid: 'u1' } : options.uuid ? { uuid: options.uuid } : {}),
      message: { content: [{ type: 'text', text: options.text ?? '帮我改成 TypeScript' }] },
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
          ...(options.onEdit ? { onEditUserMessage: options.onEdit } : {}),
          ...(options.onSubmitEdit ? { onSubmitEditUserMessage: options.onSubmitEdit } : {}),
          editingUserMessageUuid: options.isEditing ? (options.uuid ?? 'u1') : null,
        }),
      ),
    )
  }

  test('传入修改回调时渲染修改重发入口', () => {
    expect(renderUserGroup({ onEdit: () => {} })).toContain('修改重发')
  })

  test('不再渲染「重新生成」入口（改走修改重发）', () => {
    expect(renderUserGroup({ onEdit: () => {} })).not.toContain('重新生成')
  })

  test('用户消息操作栏默认隐藏，悬停整条消息时淡入', () => {
    const markup = renderUserGroup({ onEdit: () => {} })

    expect(markup).toContain('opacity-0 group-hover:opacity-100 focus-within:opacity-100')
  })

  test('用户名字与时间在居右时右对齐（居左时保持左对齐）', () => {
    const markup = renderUserGroup({ onEdit: () => {} })

    expect(markup).toContain('group-[.user-message-right]:items-end')
  })

  test('未传回调时不渲染入口', () => {
    expect(renderUserGroup()).not.toContain('修改重发')
  })

  test('消息没有 uuid 时不渲染修改重发入口（无法定位回退锚点）', () => {
    expect(renderUserGroup({ onEdit: () => {}, uuid: undefined, text: '' })).not.toContain('修改重发')
  })

  test('原地编辑态：编辑框渲染在消息里，而不是底部 composer', () => {
    const markup = renderUserGroup({ onEdit: () => {}, onSubmitEdit: () => {}, isEditing: true })

    // 编辑框（textarea）与取消/发送都在消息内部
    expect(markup).toContain('编辑消息...')
    expect(markup).toContain('取消')
    expect(markup).toContain('发送')
    // 编辑态下该消息不再显示 hover 操作栏
    expect(markup).not.toContain('修改重发')
  })

  test('原地编辑态不加额外说明段落（保持最小内容）', () => {
    const markup = renderUserGroup({ onEdit: () => {}, onSubmitEdit: () => {}, isEditing: true })

    expect(markup).not.toContain('发送后会回退到这条消息并重发，其后的对话会被截断，工作区文件一并恢复。')
  })

  test('原地编辑态复用消息气泡与正文排版（不换样式、不跳位置）', () => {
    const markup = renderUserGroup({ onEdit: () => {}, onSubmitEdit: () => {}, isEditing: true })

    // 与 UserMessageContent 同一套气泡与内边距
    expect(markup).toContain('rounded-[10px] bg-primary/10 px-3.5 py-2.5')
    // 与正文同一套字号/行高（随字号设置一起变）
    expect(markup).toContain('text-[length:var(--md-preview-font-size,15px)]')
    expect(markup).toContain('leading-[1.6]')
    // 最小高度 = 3 行
    expect(markup).toContain('min-h-[72px]')
  })

  test('非编辑态不渲染编辑框', () => {
    expect(renderUserGroup({ onEdit: () => {} })).not.toContain('编辑消息...')
  })

  test('点击修改重发回传该条消息的 uuid、正文与附件前缀', () => {
    // 静态渲染无法触发点击，入口回传的 payload 由 splitUserMessagePrefix 决定切点：
    // 这里直接按同口径验证「附件/引用前缀不被丢掉」。
    const rawText = '<attached_files>\n<file path="/tmp/a.ts" />\n</attached_files>\n\n帮我改成 TypeScript'
    const { text } = parseAttachedFiles(rawText)
    expect(text).toBe('帮我改成 TypeScript')
    expect(splitUserMessagePrefix(rawText, text)).toBe('<attached_files>\n<file path="/tmp/a.ts" />\n</attached_files>')
    // 无前缀的普通消息：不凭空造前缀
    expect(splitUserMessagePrefix('帮我改成 TypeScript', '帮我改成 TypeScript')).toBe('')
    // 正文里有重复片段时，以最后一段为准（与渲染态一致）
    expect(splitUserMessagePrefix('aaa\nbbb\naaa', 'aaa')).toBe('aaa\nbbb')
  })
})
