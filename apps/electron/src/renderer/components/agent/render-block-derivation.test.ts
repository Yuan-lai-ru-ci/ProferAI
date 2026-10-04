import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock } from '@profer/shared'
import { deriveAssistantTurnBlocks, buildAssistantTurnRenderItems } from './render-block-derivation'
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

  test('同一消息 UUID 缺失时支持 _promaStableKey，复制消息对象后身份保持', () => {
    const stable = { ...message('unused', [text('<think>分析')]), uuid: undefined, _promaStableKey: 'stream-key' }
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
})
