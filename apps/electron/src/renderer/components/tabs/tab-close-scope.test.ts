import { expect, test } from 'bun:test'
import { createGroup } from '@/atoms/tab-group-atoms'
import { SCRATCH_PAD_ID, type TabItem } from '@/atoms/tab-atoms'
import { buildTabBarEntries, selectScopeTabIds } from './tab-close-scope'

const tab = (id: string, type: TabItem['type'] = 'agent'): TabItem => ({
  id,
  type,
  sessionId: id,
  title: id,
})

const scratch: TabItem = {
  id: SCRATCH_PAD_ID,
  type: 'scratch',
  sessionId: SCRATCH_PAD_ID,
  title: 'Scratch Pad',
}

// ===== 条目展开 =====

test('无组合时条目顺序与可见 Tab 一一对应', () => {
  const entries = buildTabBarEntries([scratch, tab('a'), tab('b')], [])
  expect(entries).toEqual([
    { id: SCRATCH_PAD_ID, tabIds: [SCRATCH_PAD_ID] },
    { id: 'a', tabIds: ['a'] },
    { id: 'b', tabIds: ['b'] },
  ])
})

test('组合两个成员折叠成一个条目，落在靠前成员的位置', () => {
  const tabs = [scratch, tab('a'), tab('b')]
  const group = createGroup('a', 'b', 'a')!
  const entries = buildTabBarEntries(tabs, [group])
  expect(entries.map((entry) => entry.id)).toEqual([SCRATCH_PAD_ID, 'a'])
  expect(entries[1]?.tabIds).toEqual(['a', 'b'])
})

test('组合成员中间夹着别的 Tab 时，条目顺序仍与顶栏渲染一致', () => {
  // A、C 成组，B 夹在中间：顶栏渲染为 [组合(A,C), B]。
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const group = createGroup('a', 'c', 'a')!
  const entries = buildTabBarEntries(tabs, [group])
  expect(entries.map((entry) => entry.id)).toEqual([SCRATCH_PAD_ID, 'a', 'b'])
  expect(entries[1]?.tabIds).toEqual(['a', 'c'])
})

test('组合成员全部失效时不产出条目（交给对账解散）', () => {
  const group = createGroup('gone-1', 'gone-2', 'gone-1')!
  const entries = buildTabBarEntries([scratch, tab('a')], [group])
  expect(entries.map((entry) => entry.id)).toEqual([SCRATCH_PAD_ID, 'a'])
})

// ===== 关闭其他 =====

test('关闭其他：保留目标条目，排除不可关闭的 Scratch Pad', () => {
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const entries = buildTabBarEntries(tabs, [])
  expect(selectScopeTabIds(entries, 'b', 'others')).toEqual(['a', 'c'])
})

test('关闭其他：目标是组合条目时两个成员都保留', () => {
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const group = createGroup('a', 'b', 'a')!
  const entries = buildTabBarEntries(tabs, [group])
  expect(selectScopeTabIds(entries, 'a', 'others')).toEqual(['c'])
})

test('关闭其他：传入组合的非锚点成员也能收敛到所属条目', () => {
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const group = createGroup('a', 'b', 'b')!
  const entries = buildTabBarEntries(tabs, [group])
  // 锚点是 a；传 b 应同样保留整组。
  expect(selectScopeTabIds(entries, 'b', 'others')).toEqual(['c'])
})

test('关闭其他：只有 Scratch Pad 与自身时无可关闭对象', () => {
  const entries = buildTabBarEntries([scratch, tab('a')], [])
  expect(selectScopeTabIds(entries, 'a', 'others')).toEqual([])
})

// ===== 关闭右侧 =====

test('关闭右侧：只取目标之后的条目，不越过视觉边界关掉后台 Tab', () => {
  const tabs = [scratch, tab('a'), tab('b'), tab('c'), tab('hidden-context')]
  const entries = buildTabBarEntries([scratch, tab('a'), tab('b'), tab('c')], [])
  expect(selectScopeTabIds(entries, 'b', 'right')).toEqual(['c'])
  // hidden-context 不在可见列表里，任何范围都不会碰到它。
  expect(selectScopeTabIds(entries, 'a', 'right')).not.toContain('hidden-context')
  expect(tabs).toHaveLength(5)
})

test('关闭右侧：最右条目没有可关闭对象（菜单置灰的依据）', () => {
  const entries = buildTabBarEntries([scratch, tab('a'), tab('b')], [])
  expect(selectScopeTabIds(entries, 'b', 'right')).toEqual([])
})

test('关闭右侧：右侧是组合条目时两个成员一起关闭', () => {
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const group = createGroup('b', 'c', 'b')!
  const entries = buildTabBarEntries(tabs, [group])
  expect(selectScopeTabIds(entries, 'a', 'right')).toEqual(['b', 'c'])
})

test('关闭右侧：组合在左侧时，其右侧成员不再重复出现在范围里', () => {
  // A、C 成组折叠在 A 的位置，B 在组合右侧；右键组合只能关 B。
  const tabs = [scratch, tab('a'), tab('b'), tab('c')]
  const group = createGroup('a', 'c', 'a')!
  const entries = buildTabBarEntries(tabs, [group])
  expect(selectScopeTabIds(entries, 'a', 'right')).toEqual(['b'])
})

test('目标条目不存在时返回空数组，不猜测范围', () => {
  const entries = buildTabBarEntries([scratch, tab('a')], [])
  expect(selectScopeTabIds(entries, 'ghost', 'others')).toEqual([])
  expect(selectScopeTabIds(entries, 'ghost', 'right')).toEqual([])
  expect(selectScopeTabIds([], 'a', 'right')).toEqual([])
})
