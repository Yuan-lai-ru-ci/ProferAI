/**
 * session-tree.ts — 委派会话树构建与状态聚合
 *
 * 从 LeftSidebar.tsx 抽离的纯函数：委派子会话识别、树构建、状态优先级聚合、
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

export function buildAgentSessionTrees(sessions: AgentSessionMeta[]): AgentSessionTreeItem[] {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const childrenByParentId = new Map<string, AgentSessionMeta[]>()
  const roots: AgentSessionMeta[] = []

  for (const session of sessions) {
    if (
      isDelegatedChildSession(session)
      && session.parentSessionId
      && sessionIds.has(session.parentSessionId)
      // 委派树不得跨项目归并。历史异常数据或并发切换项目产生的错误 workspaceId
      // 应保持为可见根节点，避免子会话看起来被“合并”进另一个项目。
      && sessions.some((parent) => (
        parent.id === session.parentSessionId
        && parent.workspaceId === session.workspaceId
      ))
    ) {
      const children = childrenByParentId.get(session.parentSessionId) ?? []
      children.push(session)
      childrenByParentId.set(session.parentSessionId, children)
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
  if (status) return status
  return session.delegationStatus === 'running' ? 'running' : 'idle'
}

export function getSessionTreeStatus(
  item: AgentSessionTreeItem,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  const statuses = [
    agentIndicatorMap.get(item.session.id) ?? 'idle',
    ...item.childSessions.map((session) => getDelegatedChildStatus(session, agentIndicatorMap)),
  ]

  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('completed')) return 'completed'
  return 'idle'
}

export function countCompletedDelegatedChildren(childSessions: AgentSessionMeta[]): number {
  return childSessions.filter((session) => session.delegationStatus === 'completed').length
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

export function hasPinnedVisibleParent(session: AgentSessionMeta, sessions: AgentSessionMeta[]): boolean {
  if (!isDelegatedChildSession(session) || !session.parentSessionId) return false
  const parent = sessions.find((item) => item.id === session.parentSessionId)
  return !!parent?.pinned && !parent.archived
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
