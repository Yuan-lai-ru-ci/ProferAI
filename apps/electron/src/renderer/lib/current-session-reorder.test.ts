import { describe, expect, test } from 'bun:test'
import { reorderTabs, type TabItem } from '@/atoms/tab-atoms'
import {
  acceptCurrentSessionReorderDrag,
  clearCurrentSessionReorderDragState,
  CURRENT_SESSION_REORDER_MIME,
  getActiveCurrentSessionReorderTabId,
  isCurrentSessionReorderDrag,
  normalizeDropTarget,
  resolveReorderDropPosition,
  resolveReorderTargetIndex,
  setCurrentSessionReorderDragData,
} from './current-session-reorder'

function fakeDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    get types() { return [...data.keys()] },
    setData: (type: string, value: string) => { data.set(type, value) },
    getData: (type: string) => data.get(type) ?? '',
    effectAllowed: 'none',
    dropEffect: 'none',
  } as unknown as DataTransfer
}

/** 模拟真实的 tabsAtom：Scratch 固定第 0 位，中间夹杂 preview / browser 工作 Tab */
const tab = (id: string, type: TabItem['type'] = 'agent'): TabItem => ({ id, type, sessionId: id, title: id })
const tabs: TabItem[] = [
  tab('__scratch-pad__', 'scratch'),
  tab('a'),
  tab('__preview__:a', 'preview'),
  tab('b'),
  tab('c'),
  tab('__browser__:c', 'browser'),
  tab('d'),
]
const ids = (list: readonly { id: string }[]): string[] => list.map((tab) => tab.id)

function applyReorder(dragged: string, target: string, position: 'before' | 'after'): string[] {
  const insertIndex = resolveReorderTargetIndex(tabs, dragged, target, position)
  if (insertIndex === null) return ids(tabs)
  const fromIndex = tabs.findIndex((tab) => tab.id === dragged)
  return ids(reorderTabs(tabs, fromIndex, insertIndex))
}

describe('当前会话重排拖放协议', () => {
  test('Given 从把手开始拖 When 写入 dataTransfer Then 带专属 MIME 且内存态可查', () => {
    const dt = fakeDataTransfer()
    setCurrentSessionReorderDragData(dt, 'b')
    expect(isCurrentSessionReorderDrag(dt)).toBe(true)
    expect(Array.from(dt.types)).toContain(CURRENT_SESSION_REORDER_MIME)
    expect(Array.from(dt.types)).not.toContain('text/plain')
    expect(getActiveCurrentSessionReorderTabId(dt)).toBe('b')
  })

  test('Given 拖的是会话引用或普通文本 When 判定 Then 不认作重排', () => {
    const dt = fakeDataTransfer()
    dt.setData('text/plain', 'anything')
    expect(isCurrentSessionReorderDrag(dt)).toBe(false)
    expect(getActiveCurrentSessionReorderTabId(dt)).toBeNull()
  })

  test('Given 拖拽结束 When 清理内存态 Then 不再返回旧 tabId', () => {
    const dt = fakeDataTransfer()
    setCurrentSessionReorderDragData(dt, 'c')
    clearCurrentSessionReorderDragState()
    expect(getActiveCurrentSessionReorderTabId(dt)).toBeNull()
  })
})

describe('acceptCurrentSessionReorderDrag — 拖拽光标稳定性', () => {
  test('Given 重排拖放 When 容器或行收到 dragover Then 声明可放下且光标为 move', () => {
    const dt = fakeDataTransfer()
    setCurrentSessionReorderDragData(dt, 'a')
    let prevented = false
    const event = { dataTransfer: dt, preventDefault: () => { prevented = true } }
    expect(acceptCurrentSessionReorderDrag(event)).toBe(true)
    expect(prevented).toBe(true)
    expect(dt.dropEffect).toBe('move')
  })

  test('Given 非重排拖放 When 收到 dragover Then 不接管也不 preventDefault', () => {
    const dt = fakeDataTransfer()
    dt.setData('text/plain', 'anything')
    let prevented = false
    const event = { dataTransfer: dt, preventDefault: () => { prevented = true } }
    expect(acceptCurrentSessionReorderDrag(event)).toBe(false)
    expect(prevented).toBe(false)
  })
})

describe('resolveReorderDropPosition — 指针落在目标行上下半区', () => {
  test('Given 指针在上半区 When 判定 Then 插到前面', () => {
    expect(resolveReorderDropPosition(105, 100, 28)).toBe('before')
  })

  test('Given 指针在下半区或高度无效 When 判定 Then 插到后面', () => {
    expect(resolveReorderDropPosition(120, 100, 28)).toBe('after')
    expect(resolveReorderDropPosition(100, 100, 0)).toBe('after')
  })
})

describe('normalizeDropTarget — 相邻行同一个插入点只对应一根线', () => {
  test('Given 上一行 after 与下一行 before When 规范化 Then 都落在下一行的同一根线', () => {
    const fromUpperRow = normalizeDropTarget('a', 'after', 'b')
    const fromLowerRow = normalizeDropTarget('b', 'before', 'c')
    expect(fromUpperRow).toEqual({ tabId: 'b', position: 'before' })
    expect(fromLowerRow).toEqual(fromUpperRow)
  })

  test('Given 最后一行之后 When 规范化 Then 保留 after 以便线画在行底部', () => {
    expect(normalizeDropTarget('z', 'after', null)).toEqual({ tabId: 'z', position: 'after' })
  })

  test('Given before When 规范化 Then 原样保留', () => {
    expect(normalizeDropTarget('a', 'before', 'b')).toEqual({ tabId: 'a', position: 'before' })
  })
})

describe('resolveReorderTargetIndex — 按 tab.id 映射真实索引', () => {
  test('Given 同一行 When 计算 Then 返回 null 不做无谓重排', () => {
    expect(resolveReorderTargetIndex(tabs, 'b', 'b', 'before')).toBeNull()
  })

  test('Given 拖拽或目标 id 不在 tabsAtom 中 When 计算 Then 返回 null', () => {
    expect(resolveReorderTargetIndex(tabs, 'missing', 'b', 'before')).toBeNull()
    expect(resolveReorderTargetIndex(tabs, 'b', 'missing', 'before')).toBeNull()
  })

  test('Given 夹杂工作 Tab 的 tabs When 从前往后拖到 c 之后 Then 会话顺序正确且工作 Tab 原位', () => {
    expect(applyReorder('a', 'c', 'after')).toEqual([
      '__scratch-pad__', '__preview__:a', 'b', 'c', 'a', '__browser__:c', 'd',
    ])
  })

  test('Given 夹杂工作 Tab 的 tabs When 从后往前拖到 a 之前 Then 会话顺序正确且 Scratch 仍在第 0 位', () => {
    const result = applyReorder('d', 'a', 'before')
    expect(result[0]).toBe('__scratch-pad__')
    expect(result.indexOf('d')).toBeLessThan(result.indexOf('a'))
  })

  test('Given 相邻两行 When 拖到相邻位置 Then 不产生顺序变化', () => {
    expect(applyReorder('b', 'c', 'before')).toEqual(ids(tabs))
    expect(applyReorder('c', 'b', 'after')).toEqual(ids(tabs))
  })

  test('Given 拖到列表末尾之后 When 重排 Then 该项落在最后一个会话 Tab 之后', () => {
    const result = applyReorder('a', 'd', 'after')
    expect(result.indexOf('a')).toBeGreaterThan(result.indexOf('d'))
  })
})
