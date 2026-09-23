/**
 * Tab 组合 atoms —— 「组合 tab」：两个标签各占左右一栏，允许有一栏先空着
 *
 * 模型（保持扁平，避免重演 #288 那套嵌套 SplitLayoutState 的耦合）：
 * - tabsAtom 保持扁平：组合成员仍是普通标签，仍在列表与持久化里，
 *   只是**渲染时折叠成一个条目**（跳过第二个成员，在第一个成员位置渲染组合条目）。
 * - 每个组合只是一个叠加态：leftTabId / rightTabId / focusedTabId；多个组合组成扁平列表。
 * - **允许一侧为空**（null）：把当前标签拖进分区时不再自动补一个对照会话，
 *   空的那一栏由用户自己挑（拖另一个标签进来，或在空栏里从列表选择）。
 * - 焦点 = activeTabIdAtom 属于哪一侧，不另设 focusedPane：
 *   点击组内任一栏 → setActiveTabId(该侧标签)，于是既有的
 *   useSyncActiveTabSideEffects 单点同步自动把"当前会话"跟到焦点栏。
 * - "组合激活" = activeTabId ∈ 非空成员；点第三个标签只切视图，不会劫持组合。
 *
 * 纯函数（createGroup / resolveGroupMembership / planGroupDrop / reconcileGroup / 几何）
 * 与 React 无关，可直接单测。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

// ===== 类型 =====

/** 栏位：left = 左栏，right = 右栏 */
export type TabGroupSide = 'left' | 'right'

/** 组合 tab 状态（null = 无组合）。两侧可各为 null，但至少一侧非空。 */
export interface TabGroupState {
  /** 左栏标签；null = 该栏空着，等待用户选择 */
  leftTabId: string | null
  /** 右栏标签；null = 该栏空着，等待用户选择 */
  rightTabId: string | null
  /** 焦点成员，必须指向一个非空栏 */
  focusedTabId: string
}

/** 合并手势的共享状态：TabBar 写入，MainArea 读取并渲染左右投放区 */
export interface TabGroupDragState {
  draggingTabId: string | null
  hoveredPosition: TabGroupSide | null
}

/** 持久化到 settings.tabState.group 的字段 */
export interface PersistedTabGroup {
  leftTabId: string | null
  rightTabId: string | null
  focusedTabId: string
}

/** 运行期允许同时存在多个互不重叠的组合。 */
export type TabGroupsState = TabGroupState[]

/**
 * 允许参与组合的 tab 类型白名单。
 * 判据是「这个标签有独立的内容身份、可以并排看」：
 * - agent / chat：会话；
 * - preview：文件（拖进分区 = 用一栏展示这个文件；落定时会关掉该会话的内联分屏，
 *   避免同一个文件在两处同时出现）；它拖出标签栏但**未落入投放区**时仍回落为原来的
 *   "转预览分屏"，两条路径共用同一个 pointerdown，由落点决定结果；
 * - scratch / tutorial：单例固定 tab，不能有两份；
 * - plugin：PluginViewport 是独立宿主视口，同屏两份会冲突。
 */
export const GROUP_ELIGIBLE_TAB_TYPES: readonly string[] = ['agent', 'chat', 'preview']

/** 组合内分栏缝宽度，与浏览器/预览分栏保持一致 */
export const GROUP_SPLIT_GAP = 8

/** 单栏最小可用宽度，对齐 panel-layout 的 CONVERSATION_MIN_WIDTH */
export const GROUP_MIN_PANE_WIDTH = 420

/** 右栏占比的拖拽边界 */
export const GROUP_MIN_RATIO = 0.25
export const GROUP_MAX_RATIO = 0.75

/** 组合里有一栏空着时，空栏初始占比（给选择入口留位置，又不挤占有内容的一栏） */
export const GROUP_EMPTY_SIDE_RATIO = 1 / 3

/** 空栏指定在哪一侧时，右栏占比的初始值 */
export function ratioForEmptySide(side: TabGroupSide): number {
  return side === 'right' ? GROUP_EMPTY_SIDE_RATIO : 1 - GROUP_EMPTY_SIDE_RATIO
}

// ===== 纯函数 =====

/** 是否可以参与组合 */
export function isGroupEligibleTab(tab: { type: string } | null | undefined): boolean {
  return !!tab && GROUP_ELIGIBLE_TAB_TYPES.includes(tab.type)
}

/** 非空成员 id 列表（左、右顺序） */
export function groupTabIds(group: TabGroupState | null): string[] {
  if (!group) return []
  return [group.leftTabId, group.rightTabId].filter((id): id is string => !!id)
}

/** 两侧是否都已就位（用于"空栏提示"的判定） */
export function isGroupComplete(group: TabGroupState | null): boolean {
  return !!group && !!group.leftTabId && !!group.rightTabId
}

/** 空着的栏（两侧都非空时返回 null） */
export function emptyGroupSide(group: TabGroupState | null): TabGroupSide | null {
  if (!group) return null
  if (!group.leftTabId) return 'left'
  if (!group.rightTabId) return 'right'
  return null
}

/**
 * 构造组合。至少一侧非空；同一标签不能占两栏；focusedTabId 必须落在非空侧（否则回落左栏优先）。
 */
export function createGroup(
  leftTabId: string | null,
  rightTabId: string | null,
  focusedTabId?: string | null,
): TabGroupState | null {
  if (leftTabId && rightTabId && leftTabId === rightTabId) return null
  const members = [leftTabId, rightTabId].filter((id): id is string => !!id)
  if (members.length === 0) return null
  const focused = focusedTabId && members.includes(focusedTabId) ? focusedTabId : members[0]!
  return { leftTabId: leftTabId ?? null, rightTabId: rightTabId ?? null, focusedTabId: focused }
}

export function isGroupMember(group: TabGroupState | null, tabId: string | null | undefined): boolean {
  if (!group || !tabId) return false
  return group.leftTabId === tabId || group.rightTabId === tabId
}

/** 查找标签所属组合；每个标签最多属于一个组合。 */
export function findTabGroup(
  groups: readonly TabGroupState[],
  tabId: string | null | undefined,
): TabGroupState | null {
  if (!tabId) return null
  return groups.find((group) => isGroupMember(group, tabId)) ?? null
}

/**
 * 新增或替换一个组合，并移除与新组合成员重叠的旧组合。
 * 这样拖入另一个组合的成员时也不会产生一个标签同时出现在两组的非法状态。
 */
export function replaceTabGroup(
  groups: readonly TabGroupState[],
  previousGroup: TabGroupState | null,
  nextGroup: TabGroupState,
): TabGroupState[] {
  const nextIds = new Set(groupTabIds(nextGroup))
  const previousIndex = previousGroup ? groups.indexOf(previousGroup) : -1
  const retained = groups.filter((group) => (
    group !== previousGroup && !groupTabIds(group).some((id) => nextIds.has(id))
  ))
  const insertAt = previousIndex < 0 ? retained.length : Math.min(previousIndex, retained.length)
  return [...retained.slice(0, insertAt), nextGroup, ...retained.slice(insertAt)]
}

/** 从组合列表移除指定组合。 */
export function removeTabGroup(
  groups: readonly TabGroupState[],
  target: TabGroupState | null,
): TabGroupState[] {
  if (!target) return [...groups]
  return groups.filter((group) => group !== target)
}

/** 组合是否处于激活态（焦点标签是组内成员） */
export function isGroupActive(group: TabGroupState | null, activeTabId: string | null | undefined): boolean {
  return isGroupMember(group, activeTabId)
}

/** 标签在组内的位置 */
export function groupSideOf(group: TabGroupState | null, tabId: string | null | undefined): TabGroupSide | null {
  if (!group || !tabId) return null
  if (group.leftTabId === tabId) return 'left'
  if (group.rightTabId === tabId) return 'right'
  return null
}

/**
 * 点击组合栏时应切换到哪个成员。
 *
 * 只有当前本来就在组合视图里，左右栏点击才有资格切换焦点；当前正在查看组外标签时，
 * MainArea 仍复用左栏容器渲染该标签，此时 pointerdown 不能把用户劫持回组合。
 */
export function resolveGroupPaneFocusTarget(
  group: TabGroupState | null,
  activeTabId: string | null | undefined,
  side: TabGroupSide,
): string | null {
  if (!isGroupActive(group, activeTabId)) return null
  const targetId = side === 'left' ? group?.leftTabId : group?.rightTabId
  if (!targetId || targetId === activeTabId) return null
  return targetId
}

/** 切换组内焦点成员（非成员时返回原引用） */
export function focusGroupMember(group: TabGroupState | null, tabId: string | null): TabGroupState | null {
  // 直接比较而非走 isGroupMember：后者不是类型谓词，收窄不到 string
  if (!group || !tabId) return group
  if (group.leftTabId !== tabId && group.rightTabId !== tabId) return group
  if (group.focusedTabId === tabId) return group
  return { ...group, focusedTabId: tabId }
}

/**
 * 把某个标签放进指定栏（空栏填充或替换该栏成员）。
 * 与"两侧都满时的交换"不同：这里只负责放进去，被顶掉的成员回到普通独立条目。
 */
export function fillGroupSide(
  group: TabGroupState | null,
  side: TabGroupSide,
  tabId: string | null,
): TabGroupState | null {
  if (!group || !tabId) return group
  const left = side === 'left' ? tabId : group.leftTabId
  const right = side === 'right' ? tabId : group.rightTabId
  return createGroup(left, right, tabId)
}

/**
 * 合并手势的落点语义（无组合时）：
 * - 被拖标签就是当前激活标签（"只有一个会话"）：只把它放进落点那一栏，**另一栏留空**，
 *   等用户自己挑对照会话——不自动补位；
 * - 否则：被拖标签与原激活标签按落点各占一栏，焦点给被拖标签。
 */
export function resolveGroupMembership(input: {
  activeTabId: string | null
  draggedTabId: string | null
  position: TabGroupSide
}): TabGroupState | null {
  const { activeTabId, draggedTabId, position } = input
  if (!draggedTabId) return null
  if (!activeTabId || activeTabId === draggedTabId) {
    return createGroup(
      position === 'left' ? draggedTabId : null,
      position === 'right' ? draggedTabId : null,
      draggedTabId,
    )
  }
  return position === 'left'
    ? createGroup(draggedTabId, activeTabId, draggedTabId)
    : createGroup(activeTabId, draggedTabId, draggedTabId)
}

export interface GroupDropPlan {
  group: TabGroupState
  /** 落定后应激活的标签（被拖标签） */
  activeTabId: string
}

/**
 * 合并手势落定的完整语义（TabBar 只负责收集拖拽与落点，规则集中在这里便于单测）：
 * - 被拖标签已是组成员：落到另一侧 = 交换左右（仅两侧都满时）；落到原侧 = 无变化；
 * - 组合已激活、被拖标签是组外标签：放进该栏（空栏则填充，占用则替换）；
 * - 组已存在但未激活：不静默改写（返回 null，先让用户回到组合视图）；
 * - 无组合：见 resolveGroupMembership（拖当前标签时另一栏留空）。
 */
export function planGroupDrop(input: {
  group: TabGroupState | null
  activeTabId: string | null
  draggedTabId: string | null
  position: TabGroupSide
}): GroupDropPlan | null {
  const { group, activeTabId, draggedTabId, position } = input
  if (!draggedTabId) return null

  if (group && isGroupMember(group, draggedTabId)) {
    if (groupSideOf(group, draggedTabId) === position) return null
    // 交换左右（两侧都有成员才有意义）
    if (!isGroupComplete(group)) {
      return { group, activeTabId: draggedTabId }
    }
    const swapped = createGroup(group.rightTabId, group.leftTabId, draggedTabId)
    return swapped ? { group: swapped, activeTabId: draggedTabId } : null
  }

  if (group && isGroupActive(group, activeTabId)) {
    const filled = fillGroupSide(group, position, draggedTabId)
    return filled ? { group: filled, activeTabId: draggedTabId } : null
  }

  if (group) return null

  const created = resolveGroupMembership({ activeTabId, draggedTabId, position })
  return created ? { group: created, activeTabId: draggedTabId } : null
}

/**
 * 与当前标签集合对账：
 * - 某个**非空成员**被关闭/删除 → 组合解散（两个成员各自回到独立条目）；
 * - 本来就空着的一栏保持空着；
 * - 焦点成员失效 → 回到另一个非空成员。
 */
export function reconcileGroup(
  group: TabGroupState | null,
  existingTabIds: ReadonlySet<string>,
): TabGroupState | null {
  if (!group) return null
  const leftAlive = group.leftTabId ? existingTabIds.has(group.leftTabId) : null
  const rightAlive = group.rightTabId ? existingTabIds.has(group.rightTabId) : null
  if (leftAlive === false || rightAlive === false) return null
  if (leftAlive === null && rightAlive === null) return null
  if (group.focusedTabId && isGroupMember(group, group.focusedTabId)) return group
  return { ...group, focusedTabId: (group.leftTabId ?? group.rightTabId)! }
}

/** 对账多个组合，并保证恢复后的成员互不重叠。 */
export function reconcileTabGroups(
  groups: readonly TabGroupState[],
  existingTabIds: ReadonlySet<string>,
): TabGroupState[] {
  const usedTabIds = new Set<string>()
  const reconciled: TabGroupState[] = []
  for (const group of groups) {
    const next = reconcileGroup(group, existingTabIds)
    if (!next) continue
    const memberIds = groupTabIds(next)
    if (memberIds.some((id) => usedTabIds.has(id))) continue
    memberIds.forEach((id) => usedTabIds.add(id))
    reconciled.push(next)
  }
  return reconciled
}

/** 生成持久化字段；至少一侧可持久化，否则丢弃组合 */
export function toPersistedTabGroup(
  group: TabGroupState | null,
  persistentTabIds: ReadonlySet<string>,
): PersistedTabGroup | undefined {
  const reconciled = reconcileGroup(group, persistentTabIds)
  if (!reconciled) return undefined
  return {
    leftTabId: reconciled.leftTabId,
    rightTabId: reconciled.rightTabId,
    focusedTabId: reconciled.focusedTabId,
  }
}

/** 读取持久化字段；结构非法一律视为无组合 */
export function fromPersistedTabGroup(value: unknown): TabGroupState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<PersistedTabGroup>
  const left = typeof raw.leftTabId === 'string' && raw.leftTabId ? raw.leftTabId : null
  const right = typeof raw.rightTabId === 'string' && raw.rightTabId ? raw.rightTabId : null
  return createGroup(left, right, typeof raw.focusedTabId === 'string' ? raw.focusedTabId : null)
}

/** 写入新版 groups 数组；不可持久化的组合会被过滤。 */
export function toPersistedTabGroups(
  groups: readonly TabGroupState[],
  persistentTabIds: ReadonlySet<string>,
): PersistedTabGroup[] {
  return reconcileTabGroups(groups, persistentTabIds).map((group) => ({
    leftTabId: group.leftTabId,
    rightTabId: group.rightTabId,
    focusedTabId: group.focusedTabId,
  }))
}

/** 读取新版 groups 数组；旧版单个 group 由调用方包装成数组传入。 */
export function fromPersistedTabGroups(value: unknown): TabGroupState[] {
  if (!Array.isArray(value)) return []
  return value
    .map(fromPersistedTabGroup)
    .filter((group): group is TabGroupState => group !== null)
}

/** 右栏占比 clamp（拖拽入口与持久化读取共用） */
export function clampGroupRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.max(GROUP_MIN_RATIO, Math.min(GROUP_MAX_RATIO, ratio))
}

export interface GroupSplitGeometry {
  /** 右栏像素宽 */
  rightWidth: number
  /** 左栏像素宽 */
  leftWidth: number
  /** 实际生效的比例 */
  ratio: number
}

/**
 * 由容器宽度与比例算出两栏像素宽，并把比例限制在「两栏都不小于最小宽度」的区间内。
 * 容器过窄（可用宽装不下两个最小宽）时退化为等分，由调用方决定是否提示。
 */
export function resolveGroupSplitGeometry(
  containerWidth: number,
  ratio: number,
  options: { gap?: number; minPaneWidth?: number } = {},
): GroupSplitGeometry {
  const gap = options.gap ?? GROUP_SPLIT_GAP
  const minPaneWidth = options.minPaneWidth ?? GROUP_MIN_PANE_WIDTH
  const available = Math.max(0, containerWidth - gap)
  if (available <= 0) {
    return { rightWidth: 0, leftWidth: 0, ratio: clampGroupRatio(ratio) }
  }

  const base = clampGroupRatio(ratio)
  // 两栏最小宽都放不下时 clamp 区间会反转；此时等分，避免负宽度或抖动。
  if (available < minPaneWidth * 2) {
    const rightWidth = available / 2
    return { rightWidth, leftWidth: available - rightWidth, ratio: 0.5 }
  }

  const lower = minPaneWidth / available
  const upper = 1 - minPaneWidth / available
  const effective = Math.max(lower, Math.min(upper, base))
  const rightWidth = available * effective
  return { rightWidth, leftWidth: available - rightWidth, ratio: effective }
}

// ===== Atoms =====

/** 当前全部组合；运行期内存态，重启恢复由 main.tsx 读 settings.tabState.groups 写入。 */
export const tabGroupsAtom = atom<TabGroupsState>([])

/** 组合内的左右比例，持久化到 localStorage（与 previewSplitRatioAtom 同款做法） */
export const tabGroupRatioAtom = atomWithStorage<number>('profer-tab-group-ratio', 0.5)

/** 合并手势进行中的共享状态（拖拽中的标签 + 当前悬停的投放侧） */
export const tabGroupDragAtom = atom<TabGroupDragState>({ draggingTabId: null, hoveredPosition: null })

/** 是否存在组合（派生） */
export const hasTabGroupAtom = atom<boolean>((get) => get(tabGroupsAtom).length > 0)
