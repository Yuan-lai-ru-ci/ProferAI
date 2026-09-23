/**
 * tab-group-atoms 单测
 *
 * 覆盖：组合白名单、构造与成员判定、合并落点语义、对账解散、持久化读写、几何 clamp。
 * 纯函数层不依赖 React 与 jotai store。
 */

import { expect, test } from 'bun:test'
import {
  GROUP_EMPTY_SIDE_RATIO,
  GROUP_MIN_PANE_WIDTH,
  emptyGroupSide,
  fillGroupSide,
  clampGroupRatio,
  createGroup,
  findTabGroup,
  focusGroupMember,
  fromPersistedTabGroup,
  fromPersistedTabGroups,
  groupSideOf,
  groupTabIds,
  isGroupComplete,
  isGroupActive,
  isGroupEligibleTab,
  isGroupMember,
  planGroupDrop,
  ratioForEmptySide,
  reconcileGroup,
  reconcileTabGroups,
  removeTabGroup,
  replaceTabGroup,
  resolveGroupMembership,
  resolveGroupPaneFocusTarget,
  resolveGroupSplitGeometry,
  toPersistedTabGroup,
  toPersistedTabGroups,
  type TabGroupState,
} from './tab-group-atoms'

// ===== 白名单 =====

test('agent/chat/preview 可以参与组合，单例与插件视口不行', () => {
  expect(isGroupEligibleTab({ type: 'agent' })).toBe(true)
  expect(isGroupEligibleTab({ type: 'chat' })).toBe(true)
  // preview 有独立内容身份（一个文件），可以当作一栏展示；
  // 它的"转预览分屏"路径由落点判定保留（见 TabBar 的合并手势回落）
  expect(isGroupEligibleTab({ type: 'preview' })).toBe(true)
  expect(isGroupEligibleTab({ type: 'scratch' })).toBe(false)
  expect(isGroupEligibleTab({ type: 'tutorial' })).toBe(false)
  expect(isGroupEligibleTab({ type: 'plugin' })).toBe(false)
  expect(isGroupEligibleTab(null)).toBe(false)
})

// ===== 构造与成员判定 =====

test('构造组合：两侧同一标签或两侧都空时返回 null；单侧为空是合法状态', () => {
  expect(createGroup('a', 'b')).toEqual({ leftTabId: 'a', rightTabId: 'b', focusedTabId: 'a' })
  expect(createGroup('a', 'b', 'b')).toEqual({ leftTabId: 'a', rightTabId: 'b', focusedTabId: 'b' })
  // focusedTabId 必须落在组内，否则回落左栏
  expect(createGroup('a', 'b', 'c')).toEqual({ leftTabId: 'a', rightTabId: 'b', focusedTabId: 'a' })
  // 同一标签不能占两栏
  expect(createGroup('a', 'a')).toBeNull()
  // 两侧都空 → 没有组合可表达
  expect(createGroup(null, null)).toBeNull()
  // 单侧为空 = 等用户选择（focus 必须落在非空侧）
  expect(createGroup(null, 'b')).toEqual({ leftTabId: null, rightTabId: 'b', focusedTabId: 'b' })
  expect(createGroup('a', null)).toEqual({ leftTabId: 'a', rightTabId: null, focusedTabId: 'a' })
})

test('成员判定与位置', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(isGroupMember(group, 'a')).toBe(true)
  expect(isGroupMember(group, 'b')).toBe(true)
  expect(isGroupMember(group, 'c')).toBe(false)
  expect(isGroupMember(null, 'a')).toBe(false)
  expect(groupSideOf(group, 'a')).toBe('left')
  expect(groupSideOf(group, 'b')).toBe('right')
  expect(groupSideOf(group, 'c')).toBeNull()
})

test('组合激活 = 焦点标签属于组内成员（点第三个标签不劫持组合）', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(isGroupActive(group, 'a')).toBe(true)
  expect(isGroupActive(group, 'b')).toBe(true)
  expect(isGroupActive(group, 'c')).toBe(false)
  expect(isGroupActive(null, 'a')).toBe(false)
})

test('切换组内焦点成员；非成员不改变状态', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(focusGroupMember(group, 'b')).toEqual({ leftTabId: 'a', rightTabId: 'b', focusedTabId: 'b' })
  expect(focusGroupMember(group, 'a')).toBe(group)
  expect(focusGroupMember(group, 'c')).toBe(group)
  expect(focusGroupMember(group, null)).toBe(group)
})

test('点击组合栏：仅组合激活时切换焦点，查看组外会话时不被劫持回组合', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState

  expect(resolveGroupPaneFocusTarget(group, 'a', 'right')).toBe('b')
  expect(resolveGroupPaneFocusTarget(group, 'b', 'left')).toBe('a')
  expect(resolveGroupPaneFocusTarget(group, 'a', 'left')).toBeNull()
  expect(resolveGroupPaneFocusTarget(group, 'c', 'left')).toBeNull()
  expect(resolveGroupPaneFocusTarget(group, 'c', 'right')).toBeNull()
  expect(resolveGroupPaneFocusTarget(null, 'c', 'left')).toBeNull()
})

test('多组合：按成员查找、替换和中键拆分只影响目标组合', () => {
  const first = createGroup('a', 'b', 'a') as TabGroupState
  const second = createGroup('c', 'd', 'c') as TabGroupState
  const groups = [first, second]

  expect(findTabGroup(groups, 'b')).toBe(first)
  expect(findTabGroup(groups, 'd')).toBe(second)
  expect(findTabGroup(groups, 'x')).toBeNull()
  expect(removeTabGroup(groups, first)).toEqual([second])

  const replacement = createGroup('a', 'e', 'e') as TabGroupState
  expect(replaceTabGroup(groups, first, replacement)).toEqual([replacement, second])
})

test('多组合：成员移入另一组时移除重叠旧组，保证一个标签只属于一个组合', () => {
  const first = createGroup('a', 'b', 'a') as TabGroupState
  const second = createGroup('c', 'd', 'c') as TabGroupState
  const replacement = createGroup('a', 'c', 'c') as TabGroupState

  expect(replaceTabGroup([first, second], first, replacement)).toEqual([replacement])
})

// ===== 合并落点语义 =====

test('落在左半：被拖标签在左，原激活标签在右，焦点给被拖标签', () => {
  expect(resolveGroupMembership({ activeTabId: 'b', draggedTabId: 'a', position: 'left' })).toEqual({
    leftTabId: 'a',
    rightTabId: 'b',
    focusedTabId: 'a',
  })
})

test('落在右半：原激活标签在左，被拖标签在右', () => {
  expect(resolveGroupMembership({ activeTabId: 'b', draggedTabId: 'a', position: 'right' })).toEqual({
    leftTabId: 'b',
    rightTabId: 'a',
    focusedTabId: 'a',
  })
})

test('落点语义：拖当前标签 / 无激活标签时只占一栏；缺被拖标签时无组合', () => {
  // 拖的就是当前标签：只放进落点那一栏，另一栏留空
  expect(resolveGroupMembership({ activeTabId: 'a', draggedTabId: 'a', position: 'left' })).toEqual({
    leftTabId: 'a',
    rightTabId: null,
    focusedTabId: 'a',
  })
  expect(resolveGroupMembership({ activeTabId: null, draggedTabId: 'a', position: 'right' })).toEqual({
    leftTabId: null,
    rightTabId: 'a',
    focusedTabId: 'a',
  })
  expect(resolveGroupMembership({ activeTabId: 'b', draggedTabId: null, position: 'left' })).toBeNull()
})

// ===== 对账 =====

test('任一成员被关闭 → 组合解散', () => {
  const group = createGroup('a', 'b', 'b') as TabGroupState
  expect(reconcileGroup(group, new Set(['a', 'b']))).toBe(group)
  expect(reconcileGroup(group, new Set(['a', 'c']))).toBeNull()
  expect(reconcileGroup(group, new Set(['c']))).toBeNull()
  expect(reconcileGroup(null, new Set(['a']))).toBeNull()
})

test('focusedTabId 失效时回落左栏，而不是解散', () => {
  const broken = { leftTabId: 'a', rightTabId: 'b', focusedTabId: 'zzz' } as TabGroupState
  expect(reconcileGroup(broken, new Set(['a', 'b']))).toEqual({
    leftTabId: 'a',
    rightTabId: 'b',
    focusedTabId: 'a',
  })
})

// ===== 持久化 =====

test('持久化：两个成员都必须可持久化', () => {
  const group = createGroup('a', 'b', 'b') as TabGroupState
  expect(toPersistedTabGroup(group, new Set(['a', 'b']))).toEqual({
    leftTabId: 'a',
    rightTabId: 'b',
    focusedTabId: 'b',
  })
  // 成员里含 preview 这类不持久化的标签 → 不写字段，重启后自然无组合
  expect(toPersistedTabGroup(group, new Set(['a']))).toBeUndefined()
  expect(toPersistedTabGroup(null, new Set(['a', 'b']))).toBeUndefined()
})

test('读取持久化字段：非法结构视为无组合；单侧为空是合法状态', () => {
  expect(fromPersistedTabGroup(undefined)).toBeNull()
  expect(fromPersistedTabGroup(null)).toBeNull()
  expect(fromPersistedTabGroup('a')).toBeNull()
  // 只有左栏（右栏为空）仍是一个合法的不完整组合
  expect(fromPersistedTabGroup({ leftTabId: 'a' })).toEqual({
    leftTabId: 'a',
    rightTabId: null,
    focusedTabId: 'a',
  })
  expect(fromPersistedTabGroup({ leftTabId: 'a', rightTabId: 'a' })).toBeNull()
  expect(fromPersistedTabGroup({ leftTabId: 'a', rightTabId: 'b' })).toEqual({
    leftTabId: 'a',
    rightTabId: 'b',
    focusedTabId: 'a',
  })
  expect(fromPersistedTabGroup({ leftTabId: 'a', rightTabId: 'b', focusedTabId: 'b' })).toEqual({
    leftTabId: 'a',
    rightTabId: 'b',
    focusedTabId: 'b',
  })
})

test('多组合持久化：过滤失效和重叠组合并保留合法顺序', () => {
  const first = createGroup('a', 'b', 'a') as TabGroupState
  const overlapping = createGroup('b', 'c', 'b') as TabGroupState
  const second = createGroup('d', 'e', 'e') as TabGroupState
  const groups = [first, overlapping, second]

  expect(reconcileTabGroups(groups, new Set(['a', 'b', 'c', 'd', 'e']))).toEqual([first, second])
  const persisted = toPersistedTabGroups(groups, new Set(['a', 'b', 'd', 'e']))
  expect(persisted).toEqual([
    { leftTabId: 'a', rightTabId: 'b', focusedTabId: 'a' },
    { leftTabId: 'd', rightTabId: 'e', focusedTabId: 'e' },
  ])
  expect(fromPersistedTabGroups(persisted)).toEqual([first, second])
  expect(fromPersistedTabGroups({})).toEqual([])
})

// ===== 比例与几何 =====

test('比例 clamp 落在 0.25~0.75，不可信输入回落 0.5', () => {
  expect(clampGroupRatio(0.5)).toBe(0.5)
  expect(clampGroupRatio(0)).toBe(0.25)
  expect(clampGroupRatio(1)).toBe(0.75)
  expect(clampGroupRatio(Number.NaN)).toBe(0.5)
  expect(clampGroupRatio(Number.POSITIVE_INFINITY)).toBe(0.5)
})

test('几何：比例受两栏最小宽度约束后回调', () => {
  const geometry = resolveGroupSplitGeometry(1400, 0.9, { gap: 8, minPaneWidth: 420 })
  expect(geometry.rightWidth).toBeCloseTo(972, 5)
  expect(geometry.leftWidth).toBeCloseTo(420, 5)
  expect(geometry.ratio).toBeCloseTo(972 / 1392, 5)
})

test('几何：两栏宽度之和 + 分栏缝 = 容器宽度，且都不小于最小宽', () => {
  const EPSILON = 1e-6
  for (const containerWidth of [1000, 1200, 1440, 1920]) {
    for (const ratio of [0.25, 0.4, 0.5, 0.62, 0.75]) {
      const geometry = resolveGroupSplitGeometry(containerWidth, ratio, { gap: 8, minPaneWidth: 420 })
      expect(geometry.leftWidth + geometry.rightWidth).toBeCloseTo(containerWidth - 8, 5)
      expect(geometry.leftWidth).toBeGreaterThanOrEqual(420 - EPSILON)
      expect(geometry.rightWidth).toBeGreaterThanOrEqual(420 - EPSILON)
    }
  }
})

test('几何：容器装不下两个最小宽时等分，容器为 0 时输出 0', () => {
  const narrow = resolveGroupSplitGeometry(GROUP_MIN_PANE_WIDTH + 100, 0.75, { gap: 8 })
  expect(narrow.ratio).toBe(0.5)
  expect(narrow.leftWidth).toBeCloseTo(narrow.rightWidth, 5)

  expect(resolveGroupSplitGeometry(0, 0.5)).toEqual({ rightWidth: 0, leftWidth: 0, ratio: 0.5 })
  expect(resolveGroupSplitGeometry(-100, 0.5)).toEqual({ rightWidth: 0, leftWidth: 0, ratio: 0.5 })
})

// ===== 合并手势落定语义 =====

test('无组合：被拖标签 + 原激活标签按落点组组，并激活被拖标签', () => {
  expect(planGroupDrop({ group: null, activeTabId: 'b', draggedTabId: 'a', position: 'left' })).toEqual({
    group: { leftTabId: 'a', rightTabId: 'b', focusedTabId: 'a' },
    activeTabId: 'a',
  })
  expect(planGroupDrop({ group: null, activeTabId: 'b', draggedTabId: 'a', position: 'right' })).toEqual({
    group: { leftTabId: 'b', rightTabId: 'a', focusedTabId: 'a' },
    activeTabId: 'a',
  })
})

test('组内成员拖到另一侧 = 交换左右；拖回原侧 = 无变化', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(planGroupDrop({ group, activeTabId: 'a', draggedTabId: 'a', position: 'right' })).toEqual({
    group: { leftTabId: 'b', rightTabId: 'a', focusedTabId: 'a' },
    activeTabId: 'a',
  })
  expect(planGroupDrop({ group, activeTabId: 'a', draggedTabId: 'a', position: 'left' })).toBeNull()
})

test('组合已激活：组外标签落到某一侧 = 替换该侧成员', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(planGroupDrop({ group, activeTabId: 'a', draggedTabId: 'c', position: 'right' })).toEqual({
    group: { leftTabId: 'a', rightTabId: 'c', focusedTabId: 'c' },
    activeTabId: 'c',
  })
  expect(planGroupDrop({ group, activeTabId: 'a', draggedTabId: 'c', position: 'left' })).toEqual({
    group: { leftTabId: 'c', rightTabId: 'b', focusedTabId: 'c' },
    activeTabId: 'c',
  })
})

test('组已存在但未激活：不静默改写组合', () => {
  const group = createGroup('a', 'b', 'a') as TabGroupState
  expect(planGroupDrop({ group, activeTabId: 'c', draggedTabId: 'd', position: 'left' })).toBeNull()
})

test('落定入参：缺被拖标签时无变化；无激活标签或拖自身时占一栏', () => {
  expect(planGroupDrop({ group: null, activeTabId: null, draggedTabId: 'a', position: 'left' })).toEqual({
    group: { leftTabId: 'a', rightTabId: null, focusedTabId: 'a' },
    activeTabId: 'a',
  })
  expect(planGroupDrop({ group: null, activeTabId: 'b', draggedTabId: null, position: 'left' })).toBeNull()
  expect(planGroupDrop({ group: null, activeTabId: 'a', draggedTabId: 'a', position: 'left' })).toEqual({
    group: { leftTabId: 'a', rightTabId: null, focusedTabId: 'a' },
    activeTabId: 'a',
  })
})

// ===== 被拖标签就是当前激活标签：回退对照标签 =====

test('拖的是当前激活标签时，另一栏留空等用户自己选（不自动补位）', () => {
  expect(
    planGroupDrop({ group: null, activeTabId: 'a', draggedTabId: 'a', position: 'left' }),
  ).toEqual({
    group: { leftTabId: 'a', rightTabId: null, focusedTabId: 'a' },
    activeTabId: 'a',
  })
  expect(
    planGroupDrop({ group: null, activeTabId: 'a', draggedTabId: 'a', position: 'right' }),
  ).toEqual({
    group: { leftTabId: null, rightTabId: 'a', focusedTabId: 'a' },
    activeTabId: 'a',
  })
})

test('被拖标签不是当前激活标签时，两者各占一栏', () => {
  expect(
    planGroupDrop({ group: null, activeTabId: 'b', draggedTabId: 'a', position: 'left' }),
  ).toEqual({
    group: { leftTabId: 'a', rightTabId: 'b', focusedTabId: 'a' },
    activeTabId: 'a',
  })
})

test('空栏填充：把标签放进空着的那一栏', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(planGroupDrop({ group: incomplete, activeTabId: 'a', draggedTabId: 'c', position: 'right' })).toEqual({
    group: { leftTabId: 'a', rightTabId: 'c', focusedTabId: 'c' },
    activeTabId: 'c',
  })
  const leftEmpty = createGroup(null, 'a', 'a') as TabGroupState
  expect(planGroupDrop({ group: leftEmpty, activeTabId: 'a', draggedTabId: 'c', position: 'left' })).toEqual({
    group: { leftTabId: 'c', rightTabId: 'a', focusedTabId: 'c' },
    activeTabId: 'c',
  })
})

test('不完整组合里拖动唯一成员：只切焦点，不改变结构', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(planGroupDrop({ group: incomplete, activeTabId: 'a', draggedTabId: 'a', position: 'right' })).toEqual({
    group: incomplete,
    activeTabId: 'a',
  })
})

test('空栏相关派生：groupTabIds / isGroupComplete / emptyGroupSide', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(groupTabIds(incomplete)).toEqual(['a'])
  expect(isGroupComplete(incomplete)).toBe(false)
  expect(emptyGroupSide(incomplete)).toBe('right')

  const leftEmpty = createGroup(null, 'b', 'b') as TabGroupState
  expect(emptyGroupSide(leftEmpty)).toBe('left')

  const full = createGroup('a', 'b', 'a') as TabGroupState
  expect(isGroupComplete(full)).toBe(true)
  expect(emptyGroupSide(full)).toBeNull()
  expect(groupTabIds(full)).toEqual(['a', 'b'])
})

test('创建组合：两侧都空则无组合', () => {
  expect(createGroup(null, null, null)).toBeNull()
  expect(createGroup('a', null, 'a')).toEqual({ leftTabId: 'a', rightTabId: null, focusedTabId: 'a' })
  expect(createGroup(null, 'b', 'b')).toEqual({ leftTabId: null, rightTabId: 'b', focusedTabId: 'b' })
})

test('fillGroupSide：填充空栏 / 替换占用栏', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(fillGroupSide(incomplete, 'right', 'c')).toEqual({
    leftTabId: 'a',
    rightTabId: 'c',
    focusedTabId: 'c',
  })
  const full = createGroup('a', 'b', 'a') as TabGroupState
  expect(fillGroupSide(full, 'left', 'c')).toEqual({
    leftTabId: 'c',
    rightTabId: 'b',
    focusedTabId: 'c',
  })
  expect(fillGroupSide(full, 'left', null)).toBe(full)
})

test('对账：不完整组合里空着的一栏保持空着，成员消失才解散', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(reconcileGroup(incomplete, new Set(['a', 'x']))).toBe(incomplete)
  expect(reconcileGroup(incomplete, new Set(['x']))).toBeNull()

  const leftEmpty = createGroup(null, 'b', 'b') as TabGroupState
  expect(reconcileGroup(leftEmpty, new Set(['b']))).toBe(leftEmpty)
})

test('持久化：允许一侧为空', () => {
  const incomplete = createGroup('a', null, 'a') as TabGroupState
  expect(toPersistedTabGroup(incomplete, new Set(['a']))).toEqual({
    leftTabId: 'a',
    rightTabId: null,
    focusedTabId: 'a',
  })
  expect(fromPersistedTabGroup({ leftTabId: 'a', rightTabId: null, focusedTabId: 'a' })).toEqual({
    leftTabId: 'a',
    rightTabId: null,
    focusedTabId: 'a',
  })
  expect(fromPersistedTabGroup({ leftTabId: null, rightTabId: 'b' })).toEqual({
    leftTabId: null,
    rightTabId: 'b',
    focusedTabId: 'b',
  })
})

// ===== 空栏初始占比 =====

test('空栏初始占比：空栏只占 1/3，且落在可拖拽边界内', () => {
  expect(GROUP_EMPTY_SIDE_RATIO).toBeCloseTo(1 / 3, 6)
  expect(ratioForEmptySide('right')).toBeCloseTo(1 / 3, 6)
  expect(ratioForEmptySide('left')).toBeCloseTo(2 / 3, 6)
  // 必须能直接喂给几何函数（不被 clamp 改写）
  expect(resolveGroupSplitGeometry(1400, ratioForEmptySide('right')).ratio).toBeCloseTo(1 / 3, 6)
  expect(resolveGroupSplitGeometry(1400, ratioForEmptySide('left')).ratio).toBeCloseTo(2 / 3, 6)
})
