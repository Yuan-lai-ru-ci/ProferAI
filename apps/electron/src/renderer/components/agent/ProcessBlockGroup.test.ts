import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { ProcessBlockGroup, buildAssistantTurnRenderItems, buildProcessGroupToolNames } from './ProcessBlockGroup'
import { applyRenderWindow } from './render-window'
import type { SDKContentBlock } from '@profer/shared'

const tool = (id: string, name = 'Read'): SDKContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
})

const thinking = (text = '分析中'): SDKContentBlock => ({
  type: 'thinking',
  thinking: text,
})

const text = (value: string): SDKContentBlock => ({
  type: 'text',
  text: value,
})

describe('Agent 过程块折叠分组', () => {
  test('given continuous thinking and tools before final text when grouping then folds them into one process group', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('process-group')
    expect(items[1]?.type).toBe('block')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
  })

  test('given intermediate text between tool runs when grouping then keeps only final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('中间说明'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(3)
    }
  })

  test('given streaming turn with trailing text when grouping then keeps the whole turn inside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('可能还是中间说明'),
    ], { isStreaming: true })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming turn with completed tools before trailing text when grouping then keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-1']) })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given keep expanded after complete when grouping then still keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
  })

  test('given pure text streaming turn when grouping then keeps text as normal output', () => {
    const items = buildAssistantTurnRenderItems([
      text('普通回答'),
    ], { isStreaming: true })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('block')
  })

  test('given process only turn when grouping then folds the whole turn', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming turn with only thinking before trailing text when grouping then keeps the whole turn inside process group', () => {
    // 仅有 thinking + 尾部 text 时，工具调用可能稍后才出现，
    // 不应把这段尾部 text 提前外置——避免后续完成瞬间从外部又跳回过程组。
    const items = buildAssistantTurnRenderItems([
      thinking(),
      text('暂时的回答片段'),
    ], { isStreaming: true, completedToolResultIds: new Set() })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming multi-tool turn with only the last tool result pending when grouping then keeps final text outside process group', () => {
    // 修复「最终回复被折叠」：多工具长序列中最后一个工具结果晚到时，
    // 末尾 text 几乎可确定是最终回复，应外置而非整组折叠。
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      tool('tool-2'),
      tool('tool-3'),
      text('最终回复'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-1', 'tool-2']) })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(3)
    }
  })

  test('given streaming multi-tool turn with a non-last tool result pending when grouping then keeps the whole turn inside process group', () => {
    // 中间工具未完成：末尾 text 仍可能是给后续工具看的中间说明，保持折叠。
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      tool('tool-2'),
      text('可能的中间说明'),
    ], { isStreaming: true, completedToolResultIds: new Set(['tool-2']) })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
  })

  test('given final answer followed by a trailing thinking block when grouping then keeps the answer outside the process group', () => {
    // 修复「最终回复被折叠」：真实流式数据里同一条 assistant 消息可能是 [text, thinking]
    // （reasoning 晚于正文到达），旧实现因末块不是 text 而把整段回复折叠成「执行过程」。
    const items = buildAssistantTurnRenderItems([
      text('这是最终回复'),
      thinking('收尾思考'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(0)
    }
  })

  test('given final answer between steps and a trailing thinking block when grouping then only folds the process blocks', () => {
    // turn 内聚合后以 thinking 收尾时，正文仍然必须外置。
    const items = buildAssistantTurnRenderItems([
      thinking('开工思考'),
      text('最终回复'),
      thinking('收尾思考'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given intermediate text with later tools and a trailing thinking block when grouping then keeps the whole turn folded', () => {
    // 正文之后仍有 tool_use：这段 text 是给工具看的中间说明，继续整组折叠。
    const items = buildAssistantTurnRenderItems([
      text('中间说明'),
      thinking('中间思考'),
      tool('tool-1'),
      thinking('还在干活'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2, 3])
    }
  })

  test('given trailing thinking before final answer when grouping then folds thinking and keeps answer outside', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      thinking('收尾思考'),
      text('最终回复'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(2)
    }
  })

  test('given multi-block pure text answer when grouping then renders all text blocks as normal output', () => {
    const items = buildAssistantTurnRenderItems([
      text('第一段'),
      text('第二段'),
    ])

    expect(items.map((item) => item.type)).toEqual(['block', 'block'])
  })

  test('given repeated tools when building capability icons then returns unique tool names in order', () => {
    const toolNames = buildProcessGroupToolNames([
      tool('tool-1', 'Grep'),
      thinking(),
      tool('tool-2', 'Read'),
      tool('tool-3', 'Grep'),
      tool('tool-4', 'Bash'),
    ])

    expect(toolNames).toEqual(['Grep', 'Read', 'Bash'])
  })
})

describe('过程窗口子项身份', () => {
  test('20→21→22 段窗口前移时 wrapper 保留块 key，手动折叠状态保持', () => {
    // 受控调用真实组件，检查输出的 React element 身份和组件本地展开状态。
    // 不执行布局/折叠动画 effect，不冒充浏览器 reconciliation 验收。
    const internals = (React as unknown as {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
        ReactCurrentDispatcher: { current: unknown }
      }
    }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    const slots: unknown[] = []
    let cursor = 0
    const dispatcher = {
      useState<T>(initial: T): [T, (action: T | ((previous: T) => T)) => void] {
        const index = cursor++
        if (!(index in slots)) slots[index] = initial
        return [slots[index] as T, (action) => {
          slots[index] = typeof action === 'function'
            ? (action as (previous: T) => T)(slots[index] as T)
            : action
        }]
      },
      useRef<T>(initial: T): { current: T } {
        const index = cursor++
        if (!(index in slots)) slots[index] = { current: initial }
        return slots[index] as { current: T }
      },
      useCallback<T>(callback: T): T { return callback },
      useMemo<T>(create: () => T): T { return create() },
      useEffect() {},
    }
    const render = (length: number) => {
      const blocks = Array.from({ length }, (_, index) => tool(`tool-${index}`))
      const window = applyRenderWindow(buildAssistantTurnRenderItems(blocks))
      const group = window.items.find((item) => item.type === 'process-group')
      if (!group || group.type !== 'process-group') throw new Error('缺少过程组')
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      cursor = 0
      try {
        return ProcessBlockGroup({
          blocks: group.items.map((item) => item.block),
          isStreaming: true,
          keepExpandedAfterComplete: false,
          children: [
            window.foldedProcessItems.length > 0 && React.createElement('span', { key: 'folded' }),
            group.items.map((item) => React.createElement('span', { key: item.index, 'data-block': item.index })),
          ],
        })
      } finally { internals.ReactCurrentDispatcher.current = previous }
    }
    const wrappers = (node: React.ReactNode, keys = new Map<number, React.Key | null>()) => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement<{ children?: React.ReactNode; 'data-block'?: number }>(child)) return
        const nested = child.props.children
        if (React.isValidElement<{ 'data-block'?: number }>(nested) && nested.props['data-block'] !== undefined) {
          keys.set(nested.props['data-block'], child.key)
        }
        wrappers(nested, keys)
      })
      return keys
    }
    const first = wrappers(render(20))
    const second = wrappers(render(21))
    const third = wrappers(render(22))
    for (let index = 2; index < 20; index++) {
      expect(second.get(index)).toBe(first.get(index))
      expect(third.get(index)).toBe(first.get(index))
    }
    const tree = render(22)
    const button = React.Children.toArray(tree.props.children)[0] as React.ReactElement<{ onClick: () => void }>
    button.props.onClick()
    const collapsed = render(23)
    const content = React.Children.toArray(collapsed.props.children)[1] as React.ReactElement<{ style: { opacity: number } }>
    expect(content.props.style.opacity).toBe(0)
  })
})
