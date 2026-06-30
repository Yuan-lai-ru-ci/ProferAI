import type { AgentSessionMeta } from '@proma/shared'

/** 按最近更新时间排序 Agent 会话，保持与主进程 listAgentSessions 一致。 */
export function sortAgentSessionsByUpdatedAtDesc(
  sessions: readonly AgentSessionMeta[],
): AgentSessionMeta[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 用后端返回的新元数据替换本地条目，并按最近更新时间重新排序。 */
export function replaceAgentSessionInFreshnessOrder(
  sessions: readonly AgentSessionMeta[],
  updated: AgentSessionMeta,
): AgentSessionMeta[] {
  const others = sessions.filter((session) => session.id !== updated.id)
  return sortAgentSessionsByUpdatedAtDesc([updated, ...others])
}

/**
 * 仅插入或更新单个会话条目，保留其余条目原样。
 *
 * 用于 external_run_started 等「我只知道这一个会话的新状态」的场景：
 * 绝不删除其它会话。这避免了用一份可能陈旧的全量快照整体覆盖
 * agentSessionsAtom 时，把刚结束 turn 的父会话等条目意外冲掉的竞态。
 */
export function upsertAgentSession(
  sessions: readonly AgentSessionMeta[],
  incoming: AgentSessionMeta,
): AgentSessionMeta[] {
  const existing = sessions.find((session) => session.id === incoming.id)
  const merged: AgentSessionMeta = existing
    ? { ...existing, ...incoming }
    : incoming
  const others = sessions.filter((session) => session.id !== incoming.id)
  return sortAgentSessionsByUpdatedAtDesc([merged, ...others])
}

/**
 * 把后端权威全量快照合并进本地列表。
 *
 * `fetched` 来自 listAgentSessions()，是后端权威全量列表，天然携带「删除」语义。
 * 但高并发场景下（一次派发多个子会话），多个回调各自异步 listAgentSessions()
 * 再整体 set，谁后 resolve 谁覆盖；某回调 fetch 时刻若早于另一新会话落盘，其
 * 快照就缺这个会话，整体覆盖会把它冲掉且不再写回——这正是父会话「从列表消失
 * 且不回来」的根因。
 *
 * 折中：以 fetched 为基底（保留删除语义），但对本地存在、fetched 缺失、且本地
 * updatedAt 不早于本次快照最大 updatedAt 的条目予以保留（视为「比快照更新、尚未
 * 被 fetch 看到」的乐观条目）。既反映真实删除，又抵御陈旧快照回冲。
 */
export function mergeFetchedAgentSessions(
  prev: readonly AgentSessionMeta[],
  fetched: readonly AgentSessionMeta[],
): AgentSessionMeta[] {
  const fetchedIds = new Set(fetched.map((session) => session.id))
  const snapshotWatermark = fetched.reduce(
    (max, session) => Math.max(max, session.updatedAt),
    0,
  )
  const survivingLocalOnly = prev.filter(
    (session) =>
      !fetchedIds.has(session.id) && session.updatedAt >= snapshotWatermark,
  )
  return sortAgentSessionsByUpdatedAtDesc([...fetched, ...survivingLocalOnly])
}
