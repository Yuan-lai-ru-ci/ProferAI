/**
 * tab-group-atoms 单测
 *
 * 覆盖：组合白名单、构造与成员判定、合并落点语义、对账解散、持久化读写、几何 clamp、
 * 拖放与宽度的归属关系（宽度只归分栏缝，拖放不改宽度）。
 * 纯函数层不依赖 React 与 jotai store。
 */

import { expect, test } from 'bun:test'
import {
  GROUP_COLLAPSE_HINT_OVERSHOOT,
  GROUP_COLLAPSE_OVERSHOOT,
  GROUP_MIN_ADJUSTABLE_BAND,
  GROUP_MIN_PANE_WIDTH,
  resolveGroupDropSide,
  emptyGroupSide,
  fillGroupSide,
  clampGroupRatio,
  createGroup,
  findTabGroup,
  focusGroupMember,
  fromPersistedTabGroup,
  fromPersistedTabGroups,
  groupSessionId,
  groupSideOf,
  groupTabIds,
  isGroupComplete,
  isGroupActive,
  isGroupEligibleTab,
  isGroupMember,
  isSessionConsistentGroup,
  planAutoGroupWorkTab,
  planFollowWorkTab,
  planPreviewSplit,
  planReplaceGroupMember,
  planGroupDrop,
  reconcileGroup,
  reconcileTabGroups,
  removeTabGroup,
  replaceTabGroup,
  resolveGroupMembership,
  resolveGroupPaneFocusTarget,
  resolveGroupCollapseIntent,
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
  expect(isGroupEligibleTab({ type: 'browser' })).toBe(true)
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

test('拖放侧别按当前两栏 DOM 边界判定：右侧已有预览时仍能命中左栏', () => {
  const leftPane = { left: 100, right: 680 }
  const rightPane = { left: 688, right: 1100 }

  expect(resolveGroupDropSide({ clientX: 400, leftPane, rightPane, fallbackSplitX: 700 })).toBe('left')
  expect(resolveGroupDropSide({ clientX: 900, leftPane, rightPane, fallbackSplitX: 700 })).toBe('right')
  // 8px gap 的中点为分界；中点本身归右侧，邻接像素两边分别命中各栏。
  expect(resolveGroupDropSide({ clientX: 683.99, leftPane, rightPane, fallbackSplitX: 700 })).toBe('left')
  expect(resolveGroupDropSide({ clientX: 684, leftPane, rightPane, fallbackSplitX: 700 })).toBe('right')
})

test('拖放侧别处理空栏、边界不可用和 ResizeObserver 前的 fallback', () => {
  expect(resolveGroupDropSide({
    clientX: 400,
    leftPane: { left: 100, right: 680 },
    rightPane: null,
    fallbackSplitX: 500,
  })).toBe('left')
  expect(resolveGroupDropSide({
    clientX: 600,
    leftPane: { left: 100, right: 680 },
    rightPane: null,
    fallbackSplitX: 500,
  })).toBe('right')
  expect(resolveGroupDropSide({
    clientX: 499,
    leftPane: null,
    rightPane: null,
    fallbackSplitX: 500,
  })).toBe('left')
  expect(resolveGroupDropSide({
    clientX: 500,
    leftPane: null,
    rightPane: null,
    fallbackSplitX: 500,
  })).toBe('right')
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

test('几何：两栏宽度之和 + 分栏缝 = 容器宽度；够宽时都不小于最小宽，偏窄时让位给保底可调区间', () => {
  const EPSILON = 1e-6
  const floorShare = (1 - GROUP_MIN_ADJUSTABLE_BAND) / 2
  for (const containerWidth of [1000, 1200, 1440, 1920]) {
    for (const ratio of [0.25, 0.4, 0.5, 0.62, 0.75]) {
      const geometry = resolveGroupSplitGeometry(containerWidth, ratio, { gap: 8, minPaneWidth: 420 })
      const available = containerWidth - 8
      expect(geometry.leftWidth + geometry.rightWidth).toBeCloseTo(available, 5)
      // 420 是首选下限；只有当它会把可调区间挤到保底值以下时，才放宽到保底占比。
      const floor = Math.min(420, available * floorShare)
      expect(geometry.leftWidth).toBeGreaterThanOrEqual(floor - EPSILON)
      expect(geometry.rightWidth).toBeGreaterThanOrEqual(floor - EPSILON)
    }
  }
})

test('几何：容器偏窄时不再等分锁死，分栏缝保留保底可调区间；容器为 0 时输出 0', () => {
  // 862 ≈ 1510 窗口 + 侧栏 300 + 文件面板 300 时的主区容器宽：
  // 两栏各 420px 只剩 ±7px 可调（旧实现等分后完全拖不动），这里要求仍能横跨保底区间。
  const containerWidth = 862
  const available = containerWidth - 8
  const leftMost = resolveGroupSplitGeometry(containerWidth, 0.25, { gap: 8 })
  const rightMost = resolveGroupSplitGeometry(containerWidth, 0.75, { gap: 8 })
  expect(rightMost.rightWidth - leftMost.rightWidth).toBeCloseTo(available * GROUP_MIN_ADJUSTABLE_BAND, 5)
  expect(leftMost.leftWidth + leftMost.rightWidth).toBeCloseTo(available, 5)

  const narrow = resolveGroupSplitGeometry(GROUP_MIN_PANE_WIDTH + 100, 0.75, { gap: 8 })
  expect(narrow.ratio).toBeCloseTo((1 + GROUP_MIN_ADJUSTABLE_BAND) / 2, 6)
  expect(narrow.leftWidth + narrow.rightWidth).toBeCloseTo(GROUP_MIN_PANE_WIDTH + 100 - 8, 5)

  expect(resolveGroupSplitGeometry(0, 0.5)).toEqual({ rightWidth: 0, leftWidth: 0, ratio: 0.5 })
  expect(resolveGroupSplitGeometry(-100, 0.5)).toEqual({ rightWidth: 0, leftWidth: 0, ratio: 0.5 })
})

// ===== 拖到极限后的收起手势 =====

test('收起意图：分栏缝未到极限时没有收起意图', () => {
  // 1400px 容器：左栏极限宽 420，指针落在 700 处离极限还很远。
  expect(resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 700 })).toBeNull()
  // 刚好停在极限上（左栏 420px）只是“拖到头”，还不算收起手势。
  expect(resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 424 })).toBeNull()
})

test('收起意图：越过提示阈值先给提示，越过收起阈值才 ready', () => {
  const hint = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 410 })
  expect(hint).not.toBeNull()
  expect(hint!.side).toBe('left')
  expect(hint!.ready).toBe(false)
  expect(hint!.overshoot).toBeCloseTo(14, 6)

  const ready = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 390 })
  expect(ready).not.toBeNull()
  expect(ready!.side).toBe('left')
  expect(ready!.ready).toBe(true)
  expect(ready!.overshoot).toBeCloseTo(34, 6)

  // 阈值边界：刚好 32px 就收起，31px 仍只是提示。
  const atThreshold = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 424 - GROUP_COLLAPSE_OVERSHOOT })
  expect(atThreshold!.ready).toBe(true)
  const belowThreshold = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 424 - GROUP_COLLAPSE_OVERSHOOT + 1 })
  expect(belowThreshold!.ready).toBe(false)
  expect(GROUP_COLLAPSE_HINT_OVERSHOOT).toBeLessThan(GROUP_COLLAPSE_OVERSHOOT)
})

test('收起意图：向右侧外拖时被挤压的是右栏', () => {
  // 1400px 容器：右栏极限宽 420，指针 976 是极限位置；往右继续拖就挤压右栏。
  expect(resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 976 })).toBeNull()
  const hint = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 990 })
  expect(hint!.side).toBe('right')
  expect(hint!.ready).toBe(false)
  const ready = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 1010 })
  expect(ready!.side).toBe('right')
  expect(ready!.ready).toBe(true)
})

test('收起意图：容器够宽时极限由 0.25/0.75 比例 clamp 决定，而不是 420px', () => {
  // 1920px 容器：available 1912，0.25 比例对应 478px > 420px，所以左栏实际只能拖到 478。
  expect(resolveGroupCollapseIntent({ containerWidth: 1920, pointerX: 482 })).toBeNull()
  expect(resolveGroupCollapseIntent({ containerWidth: 1920, pointerX: 470 })!.ready).toBe(false)
  const ready = resolveGroupCollapseIntent({ containerWidth: 1920, pointerX: 448 })
  expect(ready!.side).toBe('left')
  expect(ready!.ready).toBe(true)
})

test('收起意图：容器偏窄时按保底可调区间（而非 420px）算极限', () => {
  // 862px 容器（侧栏 + 文件面板让位后）：保底下限是 available * 0.375 = 320.25。
  const containerWidth = 862
  const available = containerWidth - 8
  const minPaneWidth = available * ((1 - GROUP_MIN_ADJUSTABLE_BAND) / 2)
  const extremePointerX = minPaneWidth + 4
  expect(resolveGroupCollapseIntent({ containerWidth, pointerX: extremePointerX })).toBeNull()
  const ready = resolveGroupCollapseIntent({ containerWidth, pointerX: extremePointerX - GROUP_COLLAPSE_OVERSHOOT - 4 })
  expect(ready!.side).toBe('left')
  expect(ready!.ready).toBe(true)
})

test('收起意图：容器宽为 0 / 指针拖到容器外都不会误判', () => {
  expect(resolveGroupCollapseIntent({ containerWidth: 0, pointerX: 0 })).toBeNull()
  expect(resolveGroupCollapseIntent({ containerWidth: 8, pointerX: 0 })).toBeNull()
  // 指针跑到容器外仍按「继续外拖」理解：往右外拖挤压右栏，往左外拖挤压左栏。
  const outsideRight = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: 1600 })
  expect(outsideRight!.side).toBe('right')
  expect(outsideRight!.ready).toBe(true)
  const outsideLeft = resolveGroupCollapseIntent({ containerWidth: 1400, pointerX: -200 })
  expect(outsideLeft!.side).toBe('left')
  expect(outsideLeft!.ready).toBe(true)
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

// ===== 拖放对宽度的影响（宽度只归分栏缝，拖放不改宽度）=====

/**
 * 回归锁：这一块的宽度规则被用户否掉过两次实现（按投放指针横坐标分配、按空栏模板自动分配），
 * 两次都表现为"虚线预览和实际分栏不一致 / 上次调好的宽度不记住"。
 * 现在的约定是：拖放只决定成员与左右顺序，宽度只归分栏缝拖动（tabGroupRatioAtom）。
 * 因此这里断言"模块不再提供任何从落点/空栏推导宽度的入口"，并断言几何函数本身不再改写合法比例。
 */
test('拖放不得再提供"自动分配宽度"的入口（历史上两种做法都被否掉）', async () => {
  const api = (await import('./tab-group-atoms')) as Record<string, unknown>
  for (const forbidden of ['ratioForDropPosition', 'ratioForEmptySide', 'GROUP_EMPTY_SIDE_RATIO', 'resolveDropRatio', 'resolveDropPreviewRatio']) {
    expect(Object.hasOwn(api, forbidden), `禁止重新引入 ${forbidden}`).toBe(false)
  }
})

test('几何函数只做最小栏宽约束，不改写用户拖出来的宽度', () => {
  // 容器足够宽时，几何返回值就是用户拖出来的比例本身（虚线预览与实际两栏共用同一份几何）
  for (const memoryRatio of [0.25, 0.3, 0.42, 0.5, 0.66, 0.75]) {
    expect(resolveGroupSplitGeometry(2000, memoryRatio).ratio).toBeCloseTo(memoryRatio, 6)
  }
  // 容器偏窄时只受最小栏宽约束（这是尺寸约束，不是"按落点/空栏"的业务分配）
  const narrow = resolveGroupSplitGeometry(1400, 0.25)
  expect(narrow.rightWidth).toBeCloseTo(GROUP_MIN_PANE_WIDTH, 6)
  expect(narrow.leftWidth).toBeGreaterThanOrEqual(GROUP_MIN_PANE_WIDTH - 1e-6)
  // 同一输入幂等：预览与实际各算一次必然相等
  const twin = resolveGroupSplitGeometry(2000, 0.661)
  expect(resolveGroupSplitGeometry(2000, twin.ratio)).toEqual(twin)
})

// ===== 程序化自动建组（浏览器推送 / 自动预览跟随）=====

test('planAutoGroupWorkTab：正看着对话且无组合时建立左右两栏，焦点在对话', () => {
  const next = planAutoGroupWorkTab({
    groups: [],
    agentTabId: 's1',
    workTabId: '__browser__:s1',
    activeTabId: 's1',
  })
  expect(next).toHaveLength(1)
  expect(next![0]).toEqual({ leftTabId: 's1', rightTabId: '__browser__:s1', focusedTabId: 's1' })
})

test('planAutoGroupWorkTab：用户不在看该对话、或任一成员已入组时不建组', () => {
  expect(planAutoGroupWorkTab({ groups: [], agentTabId: 's1', workTabId: '__browser__:s1', activeTabId: 's2' })).toBeNull()
  const existing = [{ leftTabId: 's1', rightTabId: 'x', focusedTabId: 's1' }]
  expect(planAutoGroupWorkTab({ groups: existing, agentTabId: 's1', workTabId: '__browser__:s1', activeTabId: 's1' })).toBeNull()
})

test('planFollowWorkTab：对话+同会话预览组合跟随最新文件，焦点留在对话', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: '__preview__:s1:a', type: 'preview', sessionId: 's1', title: 'a', filePath: '/w/a' },
    { id: '__preview__:s1:b', type: 'preview', sessionId: 's1', title: 'b', filePath: '/w/b' },
  ] as const
  const groups = [{ leftTabId: 's1', rightTabId: '__preview__:s1:a', focusedTabId: 's1' }]
  const next = planFollowWorkTab({
    groups,
    tabs,
    agentTabId: 's1',
    workTabId: '__preview__:s1:b',
    activeTabId: 's1',
  })
  expect(next).toHaveLength(1)
  expect(next![0]).toEqual({ leftTabId: 's1', rightTabId: '__preview__:s1:b', focusedTabId: 's1' })
})

test('planPreviewSplit：无组合时把会话与预览摆成左右两栏，焦点按参数', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: '__preview__:s1:a', type: 'preview', sessionId: 's1', title: 'a', filePath: '/w/a' },
  ] as const
  const next = planPreviewSplit({ groups: [], tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'preview' })
  expect(next!.focusedTabId).toBe('__preview__:s1:a')
  expect(next!.groups).toEqual([{ leftTabId: 's1', rightTabId: '__preview__:s1:a', focusedTabId: '__preview__:s1:a' }])
  // 不要求用户此刻正看着该会话（与 planFollowWorkTab 的关键区别）
  const focusedAgent = planPreviewSplit({ groups: [], tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'agent' })
  expect(focusedAgent!.focusedTabId).toBe('s1')
})

test('planPreviewSplit：会话已在右栏时预览补左栏，不改变用户摆的左右顺序', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: '__preview__:s1:a', type: 'preview', sessionId: 's1', title: 'a', filePath: '/w/a' },
  ] as const
  const groups = [{ leftTabId: null, rightTabId: 's1', focusedTabId: 's1' }] as const
  const next = planPreviewSplit({ groups: [...groups], tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'preview' })
  expect(next!.groups[0]).toEqual({ leftTabId: '__preview__:s1:a', rightTabId: 's1', focusedTabId: '__preview__:s1:a' })
})

test('planPreviewSplit：对侧是浏览器/其他会话内容时不改写用户布局', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: '__browser__:s1', type: 'browser', sessionId: 's1', title: '浏览器' },
  ] as const
  const groups = [{ leftTabId: 's1', rightTabId: '__browser__:s1', focusedTabId: 's1' }]
  expect(planPreviewSplit({ groups, tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'preview' })).toBeNull()
})

test('planReplaceGroupMember：新页接管原分屏栏，会话焦点不被抢走', () => {
  const group = createGroup('agent', 'page-old', 'agent')!
  const plan = planReplaceGroupMember({
    groups: [group],
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'agent',
  })
  expect(plan?.groups).toEqual([createGroup('agent', 'page-new', 'agent')!])
  expect(plan?.activeTabId).toBe('agent')
})

test('planReplaceGroupMember：原页是焦点时焦点跟到新页', () => {
  const group = createGroup('agent', 'page-old', 'page-old')!
  const plan = planReplaceGroupMember({
    groups: [group],
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'page-old',
  })
  expect(plan?.groups).toEqual([createGroup('agent', 'page-new', 'page-new')!])
  expect(plan?.activeTabId).toBe('page-new')
})

test('planReplaceGroupMember：左栏页同样原位替换，保留左右顺序', () => {
  const group = createGroup('page-old', 'agent', 'agent')!
  const plan = planReplaceGroupMember({
    groups: [group],
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'agent',
  })
  expect(plan?.groups).toEqual([createGroup('page-new', 'agent', 'agent')!])
})

test('planReplaceGroupMember：原页不在组合里时只跟随激活页，不改布局', () => {
  const plan = planReplaceGroupMember({
    groups: [],
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'page-old',
  })
  expect(plan).toEqual({ groups: [], activeTabId: 'page-new' })
  expect(planReplaceGroupMember({
    groups: [],
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'agent',
  })).toBeNull()
})

test('planReplaceGroupMember：新页已在别的组合时不抢成员', () => {
  const groups = [createGroup('agent', 'page-old', 'agent')!, createGroup('page-new', 'agent-2', 'page-new')!]
  expect(planReplaceGroupMember({
    groups,
    previousTabId: 'page-old',
    nextTabId: 'page-new',
    activeTabId: 'agent',
  })).toBeNull()
})

test('planPreviewSplit：预览已入别的组合时不抢，同一组合内则只切焦点', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: 's2', type: 'agent', sessionId: 's2', title: 's2' },
    { id: '__preview__:s1:a', type: 'preview', sessionId: 's1', title: 'a', filePath: '/w/a' },
  ] as const
  // 预览被用户编进了「s2 + 预览」的组合：不抢
  const otherGroup = [{ leftTabId: 's2', rightTabId: '__preview__:s1:a', focusedTabId: 's2' }]
  expect(planPreviewSplit({ groups: otherGroup, tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'preview' })).toBeNull()
  // 会话与预览已在同一组合：仅切焦点，组合不变
  const sameGroup = [{ leftTabId: 's1', rightTabId: '__preview__:s1:a', focusedTabId: 's1' }]
  const next = planPreviewSplit({ groups: sameGroup, tabs, agentTabId: 's1', workTabId: '__preview__:s1:a', focus: 'preview' })
  expect(next!.groups).toBe(sameGroup)
  expect(next!.focusedTabId).toBe('__preview__:s1:a')
})

test('planFollowWorkTab：右栏是浏览器/其他会话内容时不改写用户布局', () => {
  const tabs = [
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: '__browser__:s1', type: 'browser', sessionId: 's1', title: '浏览器' },
  ] as const
  const groups = [{ leftTabId: 's1', rightTabId: '__browser__:s1', focusedTabId: 's1' }]
  expect(planFollowWorkTab({
    groups,
    tabs,
    agentTabId: 's1',
    workTabId: '__preview__:s1:a',
    activeTabId: 's1',
  })).toBeNull()
})

test('planFollowWorkTab：无组合时退化为新建组合', () => {
  const next = planFollowWorkTab({
    groups: [],
    tabs: [],
    agentTabId: 's1',
    workTabId: '__preview__:s1:a',
    activeTabId: 's1',
  })
  expect(next![0]).toEqual({ leftTabId: 's1', rightTabId: '__preview__:s1:a', focusedTabId: 's1' })
})

// ===== 同一会话边界 =====

const sessionTabs = [
  { id: 'a1', sessionId: 's1' },
  { id: 'p1', sessionId: 's1' },
  { id: 'b2', sessionId: 's2' },
]

test('groupSessionId：同会话成员返回会话 id，空栏只看非空侧', () => {
  expect(groupSessionId(createGroup('a1', 'p1', 'a1'), sessionTabs)).toBe('s1')
  expect(groupSessionId(createGroup('a1', null, 'a1'), sessionTabs)).toBe('s1')
  expect(groupSessionId(createGroup(null, 'p1', 'p1'), sessionTabs)).toBe('s1')
})

test('groupSessionId：跨会话成员或成员缺失返回 null', () => {
  expect(groupSessionId(createGroup('a1', 'b2', 'a1'), sessionTabs)).toBeNull()
  expect(groupSessionId(createGroup('a1', 'ghost', 'a1'), sessionTabs)).toBeNull()
  expect(groupSessionId(null, sessionTabs)).toBeNull()
})

test('isSessionConsistentGroup：跨会话组合不合法，应被解散', () => {
  expect(isSessionConsistentGroup(createGroup('a1', 'p1', 'a1'), sessionTabs)).toBe(true)
  expect(isSessionConsistentGroup(createGroup('a1', null, 'a1'), sessionTabs)).toBe(true)
  expect(isSessionConsistentGroup(createGroup('a1', 'b2', 'a1'), sessionTabs)).toBe(false)
})
