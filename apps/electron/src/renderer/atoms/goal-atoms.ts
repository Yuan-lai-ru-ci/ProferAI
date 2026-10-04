import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentGoalContract, AgentGoalEvent, AgentGoalState } from '@profer/shared'

// 保留 renderer 旧引用入口，操作权限统一由 shared 推导。
export { getGoalActions } from '@profer/shared'

export const agentGoalsAtom = atom<Map<string, AgentGoalState>>(new Map())
export const goalHistoryAtomFamily = atomFamily((_sessionId: string) => atom<AgentGoalState[] | null>(null))

function isClearedGoal(goal: AgentGoalState): boolean {
  return goal.reasonCode === 'cleared' || goal.stopReason === 'cleared'
}

// 清除后仍保留版本和 owner，防止迟到事件或启动水合复活旧目标。
const goalSnapshotsAtom = atom<Map<string, AgentGoalState>>(new Map())
const retiredGoalIdsAtom = atom<Map<string, ReadonlySet<string>>>(new Map())

export const mergeAgentGoalAtom = atom(null, (get, set, event: AgentGoalEvent): boolean => {
  const incoming = event.state
  // null 不携带 owner，不能证明它清除的是哪个 Goal；main 应发送 cleared 快照。
  if (!incoming || incoming.sessionId !== event.sessionId) return false
  const previous = get(goalSnapshotsAtom).get(event.sessionId) ?? get(agentGoalsAtom).get(event.sessionId)
  const retired = get(retiredGoalIdsAtom).get(event.sessionId)
  if (retired?.has(incoming.id)) return false
  if (previous) {
    if (incoming.id === previous.id) {
      if (isClearedGoal(previous)) return false
      if (previous.revision !== undefined) {
        if (incoming.revision === undefined || incoming.revision <= previous.revision) return false
      } else if (incoming.revision === undefined && incoming.updatedAt <= previous.updatedAt) return false
    } else {
      // revision 属于单个 Goal，不能用旧 Goal 的高 revision 或 updatedAt 抢占新 owner。
      if (incoming.startedAt < previous.startedAt) return false
      if (incoming.startedAt === previous.startedAt && !isClearedGoal(previous) && previous.status !== 'completed') return false
      set(retiredGoalIdsAtom, new Map(get(retiredGoalIdsAtom)).set(event.sessionId, new Set([...(retired ?? []), previous.id])))
    }
  }
  set(goalSnapshotsAtom, new Map(get(goalSnapshotsAtom)).set(event.sessionId, incoming))
  const next = new Map(get(agentGoalsAtom))
  if (isClearedGoal(incoming)) {
    next.delete(event.sessionId)
    // 先展示已确认的归档快照，避免 clear 的 void 回包或历史读取失败让状态栏消失。
    set(goalHistoryAtomFamily(event.sessionId), (history) => [incoming, ...(history ?? []).filter((state) => state.id !== incoming.id)])
  } else next.set(event.sessionId, incoming)
  set(agentGoalsAtom, next)
  return true
})

/** list 请求发出后到达的 live 状态优先；水合只填尚未观察到的会话。 */
export const hydrateAgentGoalsAtom = atom(null, (get, set, goals: AgentGoalState[]) => {
  for (const state of goals) {
    if (get(goalSnapshotsAtom).has(state.sessionId) || get(agentGoalsAtom).has(state.sessionId)) continue
    set(mergeAgentGoalAtom, { sessionId: state.sessionId, state })
  }
})

export const agentGoalAtomFamily = atomFamily((sessionId: string) => atom(
  (get) => get(agentGoalsAtom).get(sessionId),
  (_get, set, state: AgentGoalState | null) => set(mergeAgentGoalAtom, { sessionId, state }),
))

export const goalEditorAtomFamily = atomFamily((_sessionId: string) => atom<AgentGoalState | null>(null))
export const goalActionPendingAtomFamily = atomFamily((_sessionId: string) => atom(false))
export const goalReplacementAtomFamily = atomFamily((_sessionId: string) => atom<{
  previous: AgentGoalState
  goal: string
  contract?: AgentGoalContract
} | null>(null))

export const GOAL_STATUS_LABELS: Record<AgentGoalState['status'], string> = {
  active: '执行中', stopping: '正在停止', paused: '已暂停', completed: '已完成',
  blocked: '等待处理', failed: '执行失败', stopped: '已停止', budget_limited: '预算已耗尽',
}

type GoalStartAPI = {
  getGoal(sessionId: string): Promise<AgentGoalState | null>
  stopGoal(sessionId: string): Promise<AgentGoalState>
  clearGoal(sessionId: string): Promise<void>
  startGoal(sessionId: string, goal: string, contract?: AgentGoalContract): Promise<AgentGoalState>
}

/** 确认绑定具体 owner；替换必须完成 stop → archive/clear → start，失败不继续。 */
export async function startGoalWithReplacement(
  api: GoalStartAPI,
  sessionId: string,
  input: { goal: string; contract?: AgentGoalContract },
  confirmedGoalId?: string,
): Promise<{ state?: AgentGoalState; confirmation?: AgentGoalState }> {
  const existing = await api.getGoal(sessionId)
  if (confirmedGoalId && existing?.id !== confirmedGoalId) throw new Error('当前 Goal 已变化，请重新确认替换')
  if (existing && existing.status !== 'completed') {
    if (!confirmedGoalId) return { confirmation: existing }
    if (existing.status === 'stopping' || (existing.activeRunId && existing.status !== 'active')) throw new Error('Goal 正在停止，请等待结束后重试')
    if (existing.status === 'active') {
      await api.stopGoal(sessionId)
      const stopped = await api.getGoal(sessionId)
      if (stopped?.id !== existing.id) throw new Error('当前 Goal 已变化，请重新确认替换')
      if (stopped.status === 'active' || stopped.status === 'stopping' || stopped.activeRunId) throw new Error('Goal 正在停止，请等待结束后重试')
    }
    await api.clearGoal(sessionId)
  }
  return { state: await api.startGoal(sessionId, input.goal, input.contract) }
}
