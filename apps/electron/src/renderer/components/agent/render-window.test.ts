import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@profer/shared'
import type { AssistantTurnRenderItem, IndexedContentBlock } from './ProcessBlockGroup'
import { applyRenderWindow, DEFAULT_RENDER_WINDOW } from './render-window'

function block(text: string): SDKContentBlock {
  return { type: 'text', text } as unknown as SDKContentBlock
}

/** 构造一轮：前段是过程组（含 processCount 个段），后段是回复（replyCount 段） */
function makeItems(processCount: number, replyCount: number): AssistantTurnRenderItem[] {
  const items: AssistantTurnRenderItem[] = []
  if (processCount > 0) {
    items.push({
      type: 'process-group',
      items: Array.from({ length: processCount }, (_, i) => ({ block: block(`过程${i}`), index: i })),
    })
  }
  for (let i = 0; i < replyCount; i++) {
    items.push({ type: 'block', item: { block: block(`回复${i}`), index: processCount + i } })
  }
  return items
}

const textOf = (item: IndexedContentBlock): string => (item.block as { text: string }).text

/** 窗口内可见的所有段文本 */
const visibleTexts = (items: AssistantTurnRenderItem[]): string[] => {
  const texts: string[] = []
  for (const item of items) {
    if (item.type === 'block') texts.push((item.item.block as { text: string }).text)
    else if (item.type === 'process-group') for (const groupItem of item.items) texts.push((groupItem.block as { text: string }).text)
  }
  return texts
}

describe('渲染窗口 · 基本裁剪', () => {
  test('Given 都未超窗 When 裁剪 Then 不折叠且结构不变', () => {
    const { items, foldedProcessItems, foldedReplyItems } = applyRenderWindow(makeItems(5, 3))

    expect(foldedProcessItems).toEqual([])
    expect(foldedReplyItems).toEqual([])
    expect(visibleTexts(items)).toEqual(['过程0', '过程1', '过程2', '过程3', '过程4', '回复0', '回复1', '回复2'])
  })

  test('Given 过程超窗 When 裁剪 Then 窗口留最新 N 段、折叠的是最早的段', () => {
    const { items, foldedProcessItems, foldedReplyItems } = applyRenderWindow(makeItems(50, 2))

    // 折叠的必须是「更早的」那些
    expect(foldedProcessItems.map(textOf)).toEqual(Array.from({ length: 30 }, (_, i) => `过程${i}`))
    expect(foldedReplyItems).toEqual([])

    const visible = visibleTexts(items)
    expect(visible.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `过程${30 + i}`))
    expect(visible.slice(-2)).toEqual(['回复0', '回复1'])
  })

  test('Given 回复超窗 When 裁剪 Then 折叠最早、保留最新', () => {
    const { items, foldedReplyItems } = applyRenderWindow(makeItems(2, 45))

    const foldedCount = 45 - DEFAULT_RENDER_WINDOW.replySegments
    expect(foldedReplyItems.map(textOf)).toEqual(Array.from({ length: foldedCount }, (_, i) => `回复${i}`))
    // 可见的是最近 30 段，即 回复15..回复44
    expect(visibleTexts(items).filter((t) => t.startsWith('回复'))).toEqual(
      Array.from({ length: DEFAULT_RENDER_WINDOW.replySegments }, (_, i) => `回复${foldedCount + i}`),
    )
  })
})

describe('渲染窗口 · 过程与回复独立计数', () => {
  test('Given 过程很长 When 裁剪 Then 回复段数不受过程影响', () => {
    // 这是「分开算窗口」的核心价值：过程再长也不该把回复挤掉
    const replyCount = 10
    const { foldedReplyItems, items } = applyRenderWindow(makeItems(300, replyCount))

    expect(foldedReplyItems).toEqual([])
    expect(visibleTexts(items).filter((t) => t.startsWith('回复'))).toHaveLength(replyCount)
  })

  test('Given 回复很长 When 裁剪 Then 过程段数不受回复影响', () => {
    const { foldedProcessItems } = applyRenderWindow(makeItems(8, 200))

    expect(foldedProcessItems).toEqual([])
  })
})

describe('渲染窗口 · 不丢段（完整性）', () => {
  test('Given 两侧都超窗 When 合并窗口内与折叠段 Then 等于原始全部段', () => {
    const original = makeItems(80, 50)
    const { items, foldedProcessItems, foldedReplyItems } = applyRenderWindow(original)

    const all = [
      ...foldedProcessItems.map(textOf),
      ...visibleTexts(items).filter((t) => t.startsWith('过程')),
      ...foldedReplyItems.map(textOf),
      ...visibleTexts(items).filter((t) => t.startsWith('回复')),
    ]
    expect(all).toHaveLength(130)
    expect(new Set(all).size).toBe(130) // 无重复
    expect(all).toEqual([
      ...Array.from({ length: 80 }, (_, i) => `过程${i}`),
      ...Array.from({ length: 50 }, (_, i) => `回复${i}`),
    ])
  })

  test('Given 折叠段 When 检查来源索引 Then 仍指向原始位置', () => {
    const { foldedProcessItems } = applyRenderWindow(makeItems(50, 2))

    // 索引必须是原始索引，否则展开时渲染工具结果会找错配对
    expect(foldedProcessItems.map((item) => item.index)).toEqual(Array.from({ length: 30 }, (_, i) => i))
  })
})

describe('渲染窗口 · 过程折叠边界由调用方冻结', () => {
  test('Given 显式折叠 0 段（内容可见期冻结）When 裁剪 Then 不折叠任何段', () => {
    // 流式期间边界被冻结在 0：已渲染的过程段一律不被回收，新增段只追加。
    const { items, foldedProcessItems } = applyRenderWindow(makeItems(80, 2), DEFAULT_RENDER_WINDOW, {
      processFoldCount: 0,
    })

    expect(foldedProcessItems).toEqual([])
    expect(visibleTexts(items).filter((t) => t.startsWith('过程'))).toHaveLength(80)
  })

  test('Given 显式折叠 N 段（内容卸载后推进）When 裁剪 Then 折叠正好前 N 段', () => {
    const { items, foldedProcessItems } = applyRenderWindow(makeItems(50, 2), DEFAULT_RENDER_WINDOW, {
      processFoldCount: 30,
    })

    expect(foldedProcessItems.map(textOf)).toEqual(Array.from({ length: 30 }, (_, i) => `过程${i}`))
    expect(visibleTexts(items).filter((t) => t.startsWith('过程'))).toEqual(
      Array.from({ length: 20 }, (_, i) => `过程${30 + i}`),
    )
  })

  test('Given 冻结边界大于当前段数（段数回退）When 裁剪 Then 收敛到实际段数而非越界', () => {
    const { items, foldedProcessItems } = applyRenderWindow(makeItems(3, 1), DEFAULT_RENDER_WINDOW, {
      processFoldCount: 60,
    })

    expect(foldedProcessItems).toHaveLength(3)
    expect(visibleTexts(items).filter((t) => t.startsWith('过程'))).toEqual([])
    // 回复区不受过程边界影响
    expect(visibleTexts(items).filter((t) => t.startsWith('回复'))).toEqual(['回复0'])
  })

  test('Given 未提供折叠边界 When 裁剪 Then 保持尾部窗口行为', () => {
    const frozenOff = applyRenderWindow(makeItems(50, 2))
    const explicit = applyRenderWindow(makeItems(50, 2), DEFAULT_RENDER_WINDOW, { processFoldCount: 30 })

    expect(frozenOff.foldedProcessItems.map(textOf)).toEqual(explicit.foldedProcessItems.map(textOf))
  })
})

describe('渲染窗口 · 边界与纯函数性质', () => {
  test('Given 空输入 Then 返回空且无折叠段', () => {
    const result = applyRenderWindow([])
    expect(result.items).toEqual([])
    expect(result.foldedProcessItems).toEqual([])
    expect(result.foldedReplyItems).toEqual([])
  })

  test('Given 只有回复没有过程 Then 正常裁剪', () => {
    const { items, foldedProcessItems } = applyRenderWindow(makeItems(0, 40))
    expect(foldedProcessItems).toEqual([])
    expect(visibleTexts(items)).toHaveLength(DEFAULT_RENDER_WINDOW.replySegments)
  })

  test('Given 自定义窗口上限 Then 按自定义值裁剪', () => {
    const { foldedProcessItems, foldedReplyItems } = applyRenderWindow(makeItems(10, 10), {
      processSegments: 4,
      replySegments: 3,
    })
    expect(foldedProcessItems).toHaveLength(6)
    expect(foldedReplyItems).toHaveLength(7)
  })

  test('Given 调用裁剪 When 检查入参 Then 原始数组未被修改', () => {
    const original = makeItems(50, 40)
    const processBefore = (original[0] as { items: unknown[] }).items.length
    applyRenderWindow(original)
    expect((original[0] as { items: unknown[] }).items.length).toBe(processBefore)
    expect(original).toHaveLength(41) // 1 个过程组 + 40 段回复
  })

  test('Given 裁剪后 When 检查顺序 Then 仍是「过程组在前、回复在后」', () => {
    const { items } = applyRenderWindow(makeItems(50, 40))
    const firstBlockIndex = items.findIndex((item) => item.type === 'block')
    const lastProcessIndex = items.map((item) => item.type).lastIndexOf('process-group')
    expect(lastProcessIndex).toBeLessThan(firstBlockIndex)
  })
})
