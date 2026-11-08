/**
 * tab-close-scope — 顶栏右键「关闭其他 / 关闭右侧」的作用范围
 *
 * 两个约束决定了这里必须按「渲染条目」而不是 tabsAtom / contextTabs 的数组下标来算：
 *
 * 1. **可见性**：顶栏渲染的是 selectContextTabs 过滤后的 Tab。后台其他上下文的 Tab
 *    虽然还活在 tabsAtom 里，但用户看不见——按全量数组算会让一次右键顺手关掉一批
 *    不相干的会话，且没有撤销。所以范围只由传入的可见 Tab 决定。
 * 2. **折叠**：组合 Tab 的两个成员在顶栏折叠成一个条目（渲染在靠前成员的位置），
 *    另一个成员被跳过。因此「右侧」的视觉边界与数组下标并不一致：成员可能不相邻
 *    （A 与 C 成组、B 夹在中间），按下标算会把视觉上位于左边的成员当成右侧关掉。
 *
 * 纯函数、无 React 依赖，可直接单测（见 tab-close-scope.test.ts）。
 */

import { SCRATCH_PAD_ID, type TabItem } from '@/atoms/tab-atoms'
import { findTabGroup, groupTabIds, type TabGroupState } from '@/atoms/tab-group-atoms'

/** 顶栏的一个可见条目：普通 Tab 只有自己，组合条目含其全部成员 */
export interface TabBarEntry {
  /** 条目在顶栏的代表 id（组合 = 靠前的成员，与 TabBar 的锚点规则一致） */
  id: string
  /** 该条目覆盖的全部 Tab id（组合为两个成员） */
  tabIds: string[]
}

/** 右键批量关闭的两种范围 */
export type TabCloseScope = 'others' | 'right'

/**
 * 按顶栏的实际渲染顺序展开条目。
 *
 * 组合的折叠规则与 TabBar 的 `groupAnchorByMemberId` 保持同一套：取成员中在 tabs 里
 * 下标最小的那个作为锚点，在锚点位置渲染整个组合。两处必须同源，否则菜单算出的
 * 「右侧」会与用户看到的条目顺序错位。
 */
export function buildTabBarEntries(
  tabs: readonly TabItem[],
  groups: readonly TabGroupState[],
): TabBarEntry[] {
  const entries: TabBarEntry[] = []
  const emitted = new Set<TabGroupState>()

  for (const tab of tabs) {
    const group = findTabGroup(groups, tab.id)
    if (!group) {
      entries.push({ id: tab.id, tabIds: [tab.id] })
      continue
    }
    // 同一个组合只在锚点处产出一个条目，第二个成员到达时跳过。
    if (emitted.has(group)) continue

    const members = groupTabIds(group)
      .map((id) => ({ id, index: tabs.findIndex((candidate) => candidate.id === id) }))
      .filter((member) => member.index >= 0)
      .sort((a, b) => a.index - b.index)
    // 成员全部已失效：交给 MainArea 的对账解散，这里不产出条目。
    if (members.length === 0) continue

    emitted.add(group)
    entries.push({ id: members[0]!.id, tabIds: members.map((member) => member.id) })
  }

  return entries
}

/**
 * 计算某个条目在指定范围内要关闭的 Tab id。
 *
 * - `others`：除该条目外的所有条目成员；
 * - `right`：该条目之后的所有条目成员；
 * - 目标条目不存在（或已失效）时返回空数组，不做猜测；
 * - Scratch Pad 不可关闭，始终排除（它固定在首位，只可能落进 `others`）。
 *
 * 返回空数组同时表示「该菜单项没有作用对象」，调用方据此置灰。
 */
export function selectScopeTabIds(
  entries: readonly TabBarEntry[],
  targetEntryId: string,
  scope: TabCloseScope,
): string[] {
  // 防御性：传入组合的非锚点成员时，收敛到它所属的条目（UI 只渲染锚点，正常不会发生）。
  const targetIndex = entries.findIndex(
    (entry) => entry.id === targetEntryId || entry.tabIds.includes(targetEntryId),
  )
  if (targetIndex < 0) return []

  const scoped = scope === 'right'
    ? entries.slice(targetIndex + 1)
    : entries.filter((_, index) => index !== targetIndex)

  return scoped
    .flatMap((entry) => entry.tabIds)
    .filter((tabId) => tabId !== SCRATCH_PAD_ID)
}
