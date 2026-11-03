import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock } from '@profer/shared'
import { deriveAssistantTurnBlocks, buildAssistantTurnRenderItems, hasRenderableThinking, shouldExpandThinkingByDefault } from './render-block-derivation'
import { applyRenderWindow } from './render-window'

const text = (value: string): SDKContentBlock => ({ type: 'text', text: value })
const tool = (id: string, name = 'Read'): SDKContentBlock => ({ type: 'tool_use', id, name, input: {} })
const thinking = (value = '分析中'): SDKContentBlock => ({ type: 'thinking', thinking: value })
const message = (uuid: string, content: SDKContentBlock[], extra: Partial<SDKAssistantMessage> = {}): SDKAssistantMessage => ({
  type: 'assistant', uuid, message: { content }, parent_tool_use_id: null, ...extra,
})
const derive = (messages: SDKAssistantMessage[], isStreaming = true) => deriveAssistantTurnBlocks(messages, {
  isStreaming,
  getMessageIdentity: (msg) => msg.uuid ?? 'missing',
})

describe('稳定渲染块派生', () => {
  test('think 标签闭合拆出正文时，后方同一工具的身份不随 normalized index 改变', () => {
    const before = derive([message('m1', [text('<think>分析'), tool('tool-1')])]).topLevelItems
    const after = derive([message('m1', [text('<think>分析</think>正文'), tool('tool-1')])]).topLevelItems
    const oldTool = before.find((item) => item.block.type === 'tool_use')!
    const newTool = after.find((item) => item.block.type === 'tool_use')!
    expect(oldTool.index).toBe(1)
    expect(newTool.index).toBe(2)
    expect(newTool.identity).toBe(oldTool.identity)
    expect(newTool.identity).toContain('tool-1')
    expect(after[0]!.identity).toBe(before[0]!.identity)
  })

  test('同 raw block 的 text/thinking 使用各自 occurrence，追加新类型段不会重编号已有段', () => {
    const before = derive([message('m1', [text('开场<think>分析')])]).topLevelItems
    const after = derive([message('m1', [text('开场<think>分析</think>正文<think>补充')])]).topLevelItems
    expect(after.map((item) => item.block.type)).toEqual(['text', 'thinking', 'text', 'thinking'])
    expect(after[0]!.identity).toBe(before[0]!.identity)
    expect(after[1]!.identity).toBe(before[1]!.identity)
    expect(new Set(after.map((item) => item.identity)).size).toBe(4)
    expect(after[2]!.identity).toContain('text:1')
    expect(after[3]!.identity).toContain('thinking:1')
  })

  test('两个消息的同位置同类型块不碰撞，消息前插不改变后方块身份', () => {
    const original = message('m1', [text('正文')])
    const before = derive([original]).topLevelItems[0]!
    const after = derive([message('earlier', [text('前插')]), original]).topLevelItems[1]!
    expect(after.index).toBe(1)
    expect(after.identity).toBe(before.identity)
    expect(derive([message('m2', [text('正文')])]).topLevelItems[0]!.identity).not.toBe(before.identity)
  })

  test('同一消息 UUID 缺失时支持 _proferStableKey，复制消息对象后身份保持', () => {
    const stable = { ...message('unused', [text('<think>分析')]), uuid: undefined, _proferStableKey: 'stream-key' }
    const options = { getMessageIdentity: () => 'object-fallback', isStreaming: true }
    const first = deriveAssistantTurnBlocks([stable], options).topLevelItems[0]!
    const second = deriveAssistantTurnBlocks([{ ...stable, message: { content: [text('<think>分析</think>正文')] } }], options).topLevelItems[0]!
    expect(second.identity).toBe(first.identity)
    expect(first.identity).toContain('stream-key')
    expect(first.identity).not.toContain('object-fallback')
  })

  test('保留子代理分流与错误语义，主线 index 只用于任务映射', () => {
    const error = message('error', [], { error: { message: '失败' } })
    const result = derive([
      message('parent', [tool('agent-1', 'Agent'), tool('task-1', 'TaskCreate')]),
      message('child', [text('子代理输出')], { parent_tool_use_id: 'agent-1' }),
      error,
    ])
    expect(result.childBlocksMap.get('agent-1')).toEqual([text('子代理输出')])
    expect(result.topLevelItems.map((item) => item.index)).toEqual([0, 1])
    expect(result.hasError).toBe(true)
    expect(result.errorContent).toBe(error)
    expect(result.enrichedBlocks).toHaveLength(3)
  })

  test('终态未闭合标签兜底仍按既有规则输出正文', () => {
    const result = derive([message('m1', [text('<think>最终答复')])], false)
    expect(result.topLevelBlocks).toEqual([text('最终答复')])
  })
})

describe('窗口与分组保留派生身份', () => {
  const render = (count: number) => {
    const derived = derive([message('m1', Array.from({ length: count }, (_, index) => tool(`tool-${index}`)))])
    return applyRenderWindow(buildAssistantTurnRenderItems(derived.topLevelItems, { isStreaming: true }))
  }

  test('20→21→22 过程窗口前移只改变可见范围，既有 identity 在可见与折叠区保持', () => {
    const first = render(20)
    const second = render(21)
    const third = render(22)
    const groupItems = (result: ReturnType<typeof render>) => result.items.flatMap((item) => item.type === 'block' ? [item.item] : item.type === 'process-group' ? item.items : [])
    const before = new Map(groupItems(first).map((item) => [item.index, item.identity]))
    for (const result of [second, third]) {
      for (const item of [...groupItems(result), ...result.foldedProcessItems]) {
        const expected = before.get(item.index)
        if (expected !== undefined) expect(item.identity).toBe(expected)
      }
    }
    expect(third.foldedProcessItems.map((item) => item.index)).toEqual([0, 1])
  })

  test('流式到完成的过程/回复切换保留同一正文身份', () => {
    const derived = derive([message('m1', [tool('tool-1'), text('最终输出')])])
    const streaming = buildAssistantTurnRenderItems(derived.topLevelItems, { isStreaming: true })
    const completed = buildAssistantTurnRenderItems(derived.topLevelItems)
    const process = streaming[0]!
    const reply = completed[1]!
    expect(process.type).toBe('process-group')
    expect(reply.type).toBe('block')
    if (process.type === 'process-group' && reply.type === 'block') {
      expect(reply.item.identity).toBe(process.items[1]!.identity)
    }
  })
})

describe('隐藏 thinking 时过程组不空占位', () => {
  const deriveBlocks = (blocks: SDKContentBlock[]) => derive([message('m1', blocks)]).topLevelItems

  test('given thinking-only 流式一轮 when 上层不展示思考 then 不生成过程组（不会出现“1 条消息”却空无一物）', () => {
    const items = buildAssistantTurnRenderItems(deriveBlocks([thinking('只有思考')]), {
      isStreaming: true,
      showThinking: false,
    })

    expect(items).toEqual([])
  })

  test('given 思考与工具混合 when 上层不展示思考 then 过程组只保留可渲染块，摘要不虚计', () => {
    const items = buildAssistantTurnRenderItems(
      deriveBlocks([thinking(), tool('tool-1'), text('最终输出')]),
      { showThinking: false },
    )

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.block.type)).toEqual(['tool_use'])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.block.type).toBe('text')
    }
  })

  test('given 隐藏的思考 + 流中正文 when 上层不展示思考 then 正文直接外置（不被折叠进过程组）', () => {
    const items = buildAssistantTurnRenderItems(
      deriveBlocks([thinking(), text('正在输出的正文')]),
      { isStreaming: true, showThinking: false },
    )

    expect(items.map((item) => item.type)).toEqual(['block'])
  })

  test('given 不传 showThinking when 分组 then 保持旧行为（thinking 留在过程组里）', () => {
    const items = buildAssistantTurnRenderItems([thinking(), text('最终输出')])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.block.type)).toEqual(['thinking'])
    }
  })

  test('本轮尾部的图片工具提升为正文图片块，工具行不再重复出现', () => {
    const derived = derive([message('m1', [thinking(), tool('image-1', 'send_local_image'), text('图已生成')])])
    const image = { localPath: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png' as const }
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      imageOutputsByToolUseId: new Map([['image-1', [image]]]),
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'image-output', 'block'])
    expect(items[1]?.type === 'image-output' && items[1].images).toEqual([image])
    expect(items[0]?.type === 'process-group' && items[0].items.map((item) => item.block.type)).toEqual(['thinking'])
  })

  test('过程阶段的图片工具留在过程组，不跳到正文', () => {
    const derived = derive([message('m1', [thinking(), tool('image-1', 'send_local_image'), tool('tool-2'), text('最终输出')])])
    const image = { localPath: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png' as const }
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      imageOutputsByToolUseId: new Map([['image-1', [image]]]),
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    expect(items[0]?.type === 'process-group' && items[0].items.map((item) => item.block.type)).toEqual(['thinking', 'tool_use', 'tool_use'])
  })

  test('流式中图片不提前提升，避免结束后位置跳变', () => {
    const derived = derive([message('m1', [thinking(), tool('image-1', 'generate_image')])])
    const image = { localPath: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png' as const }
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      isStreaming: true,
      imageOutputsByToolUseId: new Map([['image-1', [image]]]),
    })

    expect(items.map((item) => item.type)).toEqual(['process-group'])
  })

  test('图片按原始顺序插在文字之间，支持图文混排', () => {
    const derived = derive([message('m1', [text('第一段'), tool('image-1', 'send_local_image'), text('第二段')])])
    const image = { localPath: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png' as const }
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      imageOutputsByToolUseId: new Map([['image-1', [image]]]),
    })

    expect(items.map((item) => item.type)).toEqual(['block', 'image-output', 'block'])
    expect(items[0]?.type === 'block' && items[0].item.block.type).toBe('text')
    expect(items[2]?.type === 'block' && items[2].item.block.type).toBe('text')
  })

  test('与图片之间隔着工具调用的文字仍留在过程组', () => {
    const derived = derive([message('m1', [text('我先看看'), tool('bash-1', 'Bash'), tool('image-1', 'send_local_image'), text('结果如下')])])
    const image = { localPath: '/tmp/a.png', filename: 'a.png', mediaType: 'image/png' as const }
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      imageOutputsByToolUseId: new Map([['image-1', [image]]]),
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'image-output', 'block'])
    expect(items[0]?.type === 'process-group' && items[0].items.map((item) => item.block.type)).toEqual(['text', 'tool_use'])
  })

  test('图片工具没有结构化图片时保持普通过程行（保留失败审计）', () => {
    const derived = derive([message('m1', [tool('image-1', 'generate_image'), text('最终输出')])])
    const items = buildAssistantTurnRenderItems(derived.topLevelItems, {
      imageOutputsByToolUseId: new Map(),
    })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    expect(items[0]?.type === 'process-group' && items[0].items.map((item) => item.block.type)).toEqual(['tool_use'])
  })
})
describe('空白思考块', () => {
  const deriveBlocks = (blocks: SDKContentBlock[]) => derive([message('m1', blocks)]).topLevelItems

  test('只有空白字符的思考块被剔除，不会撑出空的思考框', () => {
    expect(buildAssistantTurnRenderItems(deriveBlocks([thinking(' ')]))).toEqual([])
    expect(buildAssistantTurnRenderItems(deriveBlocks([thinking('\n  \n')]))).toEqual([])
    expect(hasRenderableThinking(thinking(' '))).toBe(false)
    expect(hasRenderableThinking(thinking('真思考'))).toBe(true)
    // 畸形数据（字段不是字符串）也不能让渲染崩掉。
    expect(hasRenderableThinking({ type: 'thinking' } as unknown as SDKContentBlock)).toBe(false)
  })

  test('空白思考不计入过程组，摘要里只剩真实过程块', () => {
    const items = buildAssistantTurnRenderItems(deriveBlocks([thinking(' '), tool('tool-1'), text('最终输出')]))

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.block.type)).toEqual(['tool_use'])
    }
  })

  test('流式中正文不因空白思考先外置再被工具收回过程组', () => {
    // 空白思考只说明思考内容还没到，不代表本轮没有过程阶段：正文应全程留在过程组，
    // 避免「正文跳到正文区 → 首个工具到达又缩回折叠行」的跳动。
    const onlyText = buildAssistantTurnRenderItems(deriveBlocks([thinking(' '), text('正在输出的正文')]), {
      isStreaming: true,
      completedToolResultIds: new Set(),
    })
    const withTool = buildAssistantTurnRenderItems(deriveBlocks([thinking(' '), text('正在输出的正文'), tool('tool-1')]), {
      isStreaming: true,
      completedToolResultIds: new Set(),
    })

    expect(onlyText.map((item) => item.type)).toEqual(['process-group'])
    expect(withTool.map((item) => item.type)).toEqual(['process-group'])
  })

  test('showThinking=false 与空白思考叠加时过程组仍不空占位', () => {
    const items = buildAssistantTurnRenderItems(deriveBlocks([thinking(' '), tool('tool-1')]), {
      showThinking: false,
    })

    expect(items.map((item) => item.type)).toEqual(['process-group'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.block.type)).toEqual(['tool_use'])
    }
  })
})

describe('思考块默认展开判定', () => {
  const messages = (content: SDKContentBlock[], extra: Partial<SDKAssistantMessage> = {}) => [message('m1', content, extra)]

  test('本轮只有可读思考时展开', () => {
    expect(shouldExpandThinkingByDefault([thinking('真思考')], messages([thinking('真思考')]))).toBe(true)
  })

  test('有工具调用时不展开（纯工具轮次不是空回合）', () => {
    const blocks = [thinking('真思考'), tool('tool-1')]
    expect(shouldExpandThinkingByDefault(blocks, messages(blocks))).toBe(false)
  })

  test('有正文时不展开', () => {
    const blocks = [thinking('真思考'), text('正文')]
    expect(shouldExpandThinkingByDefault(blocks, messages(blocks))).toBe(false)
  })

  test('只有空白思考时不展开', () => {
    expect(shouldExpandThinkingByDefault([thinking(' ')], messages([thinking(' ')]))).toBe(false)
  })

  test('goal 更新工具与空白正文都不算可见产出', () => {
    const blocks = [thinking('真思考'), tool('goal-1', 'update_goal')]
    expect(shouldExpandThinkingByDefault(blocks, messages(blocks))).toBe(true)
    expect(shouldExpandThinkingByDefault([thinking('真思考')], messages([text('   ')]))).toBe(true)
    expect(shouldExpandThinkingByDefault([thinking('真思考')], messages([text('正文')]))).toBe(false)
  })
})

describe('空输出回合的思考', () => {
  const emptyOutput = (content: SDKContentBlock[]) => message('m1', content, {
    error: { message: '模型未生成可见回复', errorType: 'empty_output' },
    _errorCode: 'empty_output',
  } as Partial<SDKAssistantMessage>)

  test('保留空输出消息里的思考块，错误文案不当作正文', () => {
    const derived = derive([emptyOutput([
      thinking('我算了一下，结论是 A'),
      text('模型未生成可见回复，请重试或更换模型。'),
    ])])

    expect(derived.hasError).toBe(true)
    expect(derived.topLevelBlocks.map((block) => block.type)).toEqual(['thinking'])
  })

  test('普通错误消息的正文仍整条跳过', () => {
    const derived = derive([message('m1', [thinking('思考'), text('网络错误')], {
      error: { message: '网络错误', errorType: 'network_error' },
    } as Partial<SDKAssistantMessage>)])

    expect(derived.hasError).toBe(true)
    expect(derived.topLevelBlocks).toEqual([])
  })

  test('思考提到正文位置后不再被折叠进过程组', () => {
    const derived = derive([emptyOutput([thinking('我算了一下，结论是 A')])])
    const folded = buildAssistantTurnRenderItems(derived.topLevelItems)
    const promoted = buildAssistantTurnRenderItems(derived.topLevelItems, { promoteThinkingAsReply: true })

    expect(folded.map((item) => item.type)).toEqual(['process-group'])
    expect(promoted.map((item) => item.type)).toEqual(['block'])
  })
})
