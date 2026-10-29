/**
 * session-tree.ts — 关联会话树构建与状态聚合
 *
 * 从 LeftSidebar.tsx 抽离的纯函数：关联会话识别、树构建、状态优先级聚合、
 * 子会话计数、可见性判断等。不依赖 React/atom。
 */

import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import type { AgentSessionMeta } from '@profer/shared'

export interface AgentSessionTreeItem {
  session: AgentSessionMeta
  childSessions: AgentSessionMeta[]
}

export const ACTIVE_SESSION_STATUSES: ReadonlySet<SessionIndicatorStatus> = new Set([
  'blocked',
  'running',
  'completed',
])

/** 点击"显示更多"时每次额外展开的会话数量 */
export const PROJECT_SESSION_EXPAND_STEP = 10
/** 折叠时保留的最近会话数（置顶与活跃会话不计入此上限） */
export const PROJECT_SESSION_PREVIEW_LIMIT = 8
/** 剩余不足该数量时直接展示，避免出现"显示更多（1）"这类无意义折叠 */
export const PROJECT_SESSION_TAIL_ALWAYS_VISIBLE = 2

export const ACTIVE_SESSION_STATUS_PRIORITY: Record<SessionIndicatorStatus, number> = {
  blocked: 0,
  running: 1,
  completed: 2,
  idle: 3,
}

/** 判断是否为委派子会话（有父会话且带来源委派 ID） */
export function isDelegatedChildSession(session: AgentSessionMeta): boolean {
  return !!session.parentSessionId && !!session.sourceDelegationId
}

/** 探索分支使用独立血缘字段，不参与委派删除级联。 */
export function isExplorationChildSession(session: AgentSessionMeta): boolean {
  return !!session.explorationParentSessionId && !!session.explorationSourceMessageId
}

export function getRelatedParentSessionId(session: AgentSessionMeta): string | undefined {
  if (isDelegatedChildSession(session)) return session.parentSessionId
  if (isExplorationChildSession(session)) return session.explorationParentSessionId
  return undefined
}

/**
 * 项目内会话排序：置顶优先，其余按更新时间倒序。
 *
 * 置顶不再抽到跨项目「置顶」区，而是留在所属项目顶部；
 * 同组内保持稳定排序，委托/探索子会话继续由 buildAgentSessionTrees 归并到母会话下。
 */
export function sortProjectSessions(sessions: readonly AgentSessionMeta[]): AgentSessionMeta[] {
  return [...sessions].sort((a, b) => {
    const pinnedDelta = Number(!!b.pinned) - Number(!!a.pinned)
    return pinnedDelta !== 0 ? pinnedDelta : b.updatedAt - a.updatedAt
  })
}

export function buildAgentSessionTrees(sessions: AgentSessionMeta[]): AgentSessionTreeItem[] {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const childrenByParentId = new Map<string, AgentSessionMeta[]>()
  const roots: AgentSessionMeta[] = []

  for (const session of sessions) {
    const relatedParentSessionId = getRelatedParentSessionId(session)
    if (
      relatedParentSessionId
      && sessionIds.has(relatedParentSessionId)
      // 委派树不得跨项目归并。历史异常数据或并发切换项目产生的错误 workspaceId
      // 应保持为可见根节点，避免子会话看起来被“合并”进另一个项目。
      && sessions.some((parent) => (
        parent.id === relatedParentSessionId
        && parent.workspaceId === session.workspaceId
      ))
    ) {
      const children = childrenByParentId.get(relatedParentSessionId) ?? []
      children.push(session)
      childrenByParentId.set(relatedParentSessionId, children)
      continue
    }

    roots.push(session)
  }

  return roots.map((session) => ({
    session,
    childSessions: childrenByParentId.get(session.id) ?? [],
  }))
}

export function getDelegatedChildStatus(
  session: AgentSessionMeta,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  const status = agentIndicatorMap.get(session.id)
  // 实时 blocked/running 应立即反映；但子会话本轮 stream 结束时可能先产生
  // completed 指示、后更新 delegationStatus。只要持久化委派仍是 running，
  // 就不能让这段时序窗口把父会话误显示为已完成。
  if (status === 'blocked' || status === 'running') return status
  if (session.delegationStatus === 'running') return 'running'
  return status ?? 'idle'
}

export function getRelatedChildStatus(
  session: AgentSessionMeta,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  return isDelegatedChildSession(session)
    ? getDelegatedChildStatus(session, agentIndicatorMap)
    : agentIndicatorMap.get(session.id) ?? 'idle'
}

export function getSessionTreeStatus(
  item: AgentSessionTreeItem,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  // 父会话自身状态
  const parentStatus = agentIndicatorMap.get(item.session.id) ?? 'idle'

  // 子会话只向上聚合 blocked / running：子代理正在运行或被阻塞时，
  // 父会话行需要体现"有子代理在活动"；但子代理"已完成未查看"是后台结果，
  // 不应让父会话保持绿色完成标记（用户不一定去查看子代理）。
  const childActiveStatuses = item.childSessions
    .map((session) => getRelatedChildStatus(session, agentIndicatorMap))
    .filter((status): status is 'blocked' | 'running' =>
      status === 'blocked' || status === 'running')

  if (parentStatus === 'blocked' || childActiveStatuses.includes('blocked')) return 'blocked'
  if (parentStatus === 'running' || childActiveStatuses.includes('running')) return 'running'
  if (parentStatus === 'completed') return 'completed'
  return 'idle'
}

export interface DelegationSummary {
  total: number
  running: number
  completed: number
}

/**
 * 汇总父会话的直接委派子会话状态。
 *
 * `running` 只采用持久化 delegationStatus：侧栏与正文都能在父轮次结束后、
 * 子会话仍独立运行时稳定显示等待态；终态不伪装为成功完成。
 */
export function getDelegationSummary(childSessions: AgentSessionMeta[]): DelegationSummary {
  return {
    total: childSessions.length,
    running: childSessions.filter((session) => session.delegationStatus === 'running').length,
    completed: childSessions.filter((session) => session.delegationStatus === 'completed').length,
  }
}

export interface RelatedSessionSummary extends DelegationSummary {
  label: '子会话' | '探索分支' | '关联会话'
  /**
   * 是否在父行显示 x/y 计数。
   *
   * 仅纯委派子会话显示：父行右侧已挤着时间、置顶、归档与三点菜单，
   * 探索分支需的是“是否跑出结论”而不是“看了没看”，叠加计数会与子会话抢位置且含义不可靠。
   * 探索分支的进度改由父行状态色条与分支行状态点表达。
   */
  showCount: boolean
}

/** 汇总父会话下直接关联子会话的展开信息，供侧栏父行使用。 */
export function getRelatedSessionSummary(childSessions: AgentSessionMeta[]): RelatedSessionSummary {
  const delegatedChildren = childSessions.filter(isDelegatedChildSession)
  const hasExploration = childSessions.some(isExplorationChildSession)
  const delegatedSummary = getDelegationSummary(delegatedChildren)

  return {
    total: childSessions.length,
    running: delegatedSummary.running,
    completed: delegatedSummary.completed,
    label: delegatedChildren.length > 0 && hasExploration
      ? '关联会话'
      : hasExploration
        ? '探索分支'
        : '子会话',
    showCount: !hasExploration,
  }
}

export function treeContainsSessionId(item: AgentSessionTreeItem, sessionId: string | null): boolean {
  if (!sessionId) return false
  return item.session.id === sessionId || item.childSessions.some((session) => session.id === sessionId)
}

export function collectTreeSessionIds(items: AgentSessionTreeItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    ids.add(item.session.id)
    for (const child of item.childSessions) ids.add(child.id)
  }
  return ids
}

export function getDirectDelegatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
): AgentSessionMeta[] {
  return sessions.filter((session) => (
    session.parentSessionId === parentSessionId
    && !!session.sourceDelegationId
  ))
}

export function getDirectRelatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
): AgentSessionMeta[] {
  const parent = sessions.find((session) => session.id === parentSessionId)
  if (!parent) return []
  return sessions.filter((session) => (
    getRelatedParentSessionId(session) === parentSessionId
    && session.workspaceId === parent.workspaceId
  ))
}

/** 返回包含根会话在内的全部委派后代；防御异常索引里的环。 */
export function collectDelegatedDeletionSessionIds(
  sessions: AgentSessionMeta[],
  rootSessionId: string,
): Set<string> {
  const childrenByParentId = new Map<string, AgentSessionMeta[]>()
  for (const session of sessions) {
    if (!session.parentSessionId || !session.sourceDelegationId) continue
    const children = childrenByParentId.get(session.parentSessionId) ?? []
    children.push(session)
    childrenByParentId.set(session.parentSessionId, children)
  }

  const ids = new Set<string>()
  const visit = (sessionId: string): void => {
    if (ids.has(sessionId)) return
    ids.add(sessionId)
    for (const child of childrenByParentId.get(sessionId) ?? []) visit(child.id)
  }
  visit(rootSessionId)
  return ids
}

export function getSyncableDelegatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
  draftSessionIds: Set<string>,
): AgentSessionMeta[] {
  return getDirectDelegatedChildren(sessions, parentSessionId).filter((child) => (
    !child.archived
    && !child.draft
    && !draftSessionIds.has(child.id)
  ))
}

export interface ProjectSessionVisibility {
  /** 置顶会话，固定在项目内最前，不占预览上限 */
  pinned: AgentSessionTreeItem[]
  /** 活跃会话（运行中 / 阻塞 / 未查看的已完成），折叠时也常显 */
  active: AgentSessionTreeItem[]
  /** 按 updatedAt 倒序补足的最近会话，上限 previewLimit */
  fill: AgentSessionTreeItem[]
  /** 用户点击「显示更多」后额外展开的会话 */
  extra: AgentSessionTreeItem[]
  /** 剩余不足 tailAlwaysVisible 条时直接展示的尾巴 */
  trailing: AgentSessionTreeItem[]
  /** 仍被折叠的会话数（仅计根节点） */
  hiddenCount: number
}

/**
 * 计算项目内会话的可见切片。
 *
 * 规则（对齐主流侧栏习惯）：
 * - 置顶会话与活跃会话永远可见，且不占预览上限；
 * - 其余按 updatedAt 倒序补足到 previewLimit 条，不叠加时间窗口——
 *   项目里全是旧会话时仍能看到最近若干条，不会只剩一行「显示更多」；
 * - 只有超出预览上限时才折叠；剩余不足 tailAlwaysVisible 条直接展示；
 * - 用户展开后每次追加 extraCount 条。
 */
export function computeProjectSessionVisibility(params: {
  treeItems: readonly AgentSessionTreeItem[]
  getStatus: (item: AgentSessionTreeItem) => SessionIndicatorStatus
  previewLimit?: number
  extraCount?: number
  tailAlwaysVisible?: number
}): ProjectSessionVisibility {
  const {
    treeItems,
    getStatus,
    previewLimit = PROJECT_SESSION_PREVIEW_LIMIT,
    extraCount = 0,
    tailAlwaysVisible = PROJECT_SESSION_TAIL_ALWAYS_VISIBLE,
  } = params

  const pinned = treeItems.filter((item) => !!item.session.pinned)
  const unpinned = treeItems.filter((item) => !item.session.pinned)
  const active = unpinned
    .filter((item) => ACTIVE_SESSION_STATUSES.has(getStatus(item)))
    .slice()
    .sort((a, b) => {
      const delta = ACTIVE_SESSION_STATUS_PRIORITY[getStatus(a)] - ACTIVE_SESSION_STATUS_PRIORITY[getStatus(b)]
      if (delta !== 0) return delta
      return b.session.updatedAt - a.session.updatedAt
    })
  const activeIds = collectTreeSessionIds(active)
  const fill = unpinned
    .filter((item) => !activeIds.has(item.session.id))
    .slice(0, Math.max(0, previewLimit))

  const baselineIds = new Set([...pinned, ...active, ...fill].map((item) => item.session.id))
  const remaining = unpinned.filter((item) => !baselineIds.has(item.session.id))
  const extra = remaining.slice(0, Math.max(0, extraCount))
  const rest = remaining.slice(extra.length)
  const trailing = rest.length <= Math.max(0, tailAlwaysVisible) ? rest : []

  return {
    pinned,
    active,
    fill,
    extra,
    trailing,
    hiddenCount: rest.length - trailing.length,
  }
}
