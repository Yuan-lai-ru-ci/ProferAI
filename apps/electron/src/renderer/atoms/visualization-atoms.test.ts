import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import {
  visualizationCandidatePresentAtomFamily,
  visualizationCandidatesAtom,
  visualizationHeightAtomFamily,
  visualizationHeightsAtom,
  visualizationSelectedAtomFamily,
  visualizationViewStateAtomFamily,
  visualizationViewStatesAtom,
  type VisualizationCandidate,
} from './visualization-atoms'

/**
 * 这些切片存在的唯一理由：**上下滚动时不能把会话里每个可视化组件都重渲染**。
 * 直接订阅整张 Map 的话，候选距离每跨过一个 64px 就换一次 Map，
 * 一次滚动就能把全部实例拉起来重渲染（片段每次 setState、每次高度上报同样如此）。
 * 这里的断言方式是仓库既有范式：未受影响的切片必须**引用不变**。
 */

function candidatesAtomValue(entries: Array<[string, VisualizationCandidate]>) {
  return new Map(entries)
}

describe('visualization atom families', () => {
  test('滚动只改变受影响实例的选中切片', () => {
    const store = createStore()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const slices = Object.fromEntries(ids.map((id) => [id, visualizationSelectedAtomFamily(id)]))
    // 名额是产品常量（可能变化），这里只断言“值变了的那几个”不多不少
    store.set(visualizationCandidatesAtom, new Map(ids.map((id, index) => [id, { id, distance: index * 64, focused: false, live: false }])))
    const before = Object.fromEntries(ids.map((id) => [id, store.get(slices[id]!)]))
    // 往上滚：a、b 远去（4096+），c~f 保持很近 → 只有 a、b 该被换下、e、f 该入列
    store.set(visualizationCandidatesAtom, new Map(ids.map((id, index) => [id, { id, distance: index < 2 ? 4096 + index * 64 : index * 64, focused: false, live: false }])))
    const after = Object.fromEntries(ids.map((id) => [id, store.get(slices[id]!)]))
    const changed = ids.filter((id) => before[id] !== after[id])
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.every((id) => ['a', 'b', 'e', 'f'].includes(id))).toBe(true)
    expect(after.e).toBe(true)
    expect(after.f).toBe(true)
  })

  test('焦点实例优先，且存在性切片彼此独立', () => {
    const store = createStore()
    const a = visualizationCandidatePresentAtomFamily('a')
    const b = visualizationCandidatePresentAtomFamily('b')
    const selectedA = visualizationSelectedAtomFamily('a')

    store.set(visualizationCandidatesAtom, candidatesAtomValue([
      ['b', { id: 'b', distance: 0, focused: false, live: false }],
    ]))
    expect(store.get(a)).toBe(false)
    expect(store.get(b)).toBe(true)

    store.set(visualizationCandidatesAtom, candidatesAtomValue([
      ['a', { id: 'a', distance: 999, focused: true, live: false }],
      ['b', { id: 'b', distance: 0, focused: false, live: false }],
    ]))
    // 正在操作的实例占名额，即使更远
    expect(store.get(selectedA)).toBe(true)
    expect(store.get(a)).toBe(true)
  })

  test('高度只影响对应 key 的切片', () => {
    const store = createStore()
    const keyA = visualizationHeightAtomFamily('["session","viz-a","r1"]')
    const keyB = visualizationHeightAtomFamily('["session","viz-b","r1"]')
    const beforeA = store.get(keyA)
    expect(beforeA).toBe(null)

    store.set(visualizationHeightsAtom, new Map([['["session","viz-b","r1"]', 1024]]))

    expect(store.get(keyB)).toBe(1024)
    expect(store.get(keyA)).toBe(beforeA) // 别的可视化上报高度不该惊动它
  })

  test('片段状态只影响对应 key 的切片', () => {
    const store = createStore()
    const keyA = visualizationViewStateAtomFamily('["session","viz-a","r1"]')
    const keyB = visualizationViewStateAtomFamily('["session","viz-b","r1"]')
    const beforeA = store.get(keyA)
    expect(beforeA).toEqual({})

    store.set(visualizationViewStatesAtom, new Map([['["session","viz-b","r1"]', { tab: 'data' }]]))

    expect(store.get(keyB)).toEqual({ tab: 'data' })
    expect(store.get(keyA)).toBe(beforeA) // 空状态必须是同一个常量对象，否则每次都会重渲染
  })
})
