import type { AgentGoalState } from '@profer/shared'
import { getLocalCoreClient } from './core-local-bridge'
import { currentCoreId, getActiveCoreClient, getCoreTargetGeneration, getCurrentCoreTargetId, namespaceCoreSessionId, parseCoreSessionId } from './core-target-service'

/** 只返回显式本机null；远程断线/错误/旧响应永远不回退本机Goal。 */
export async function routeGoalToCore(operation: string, sessionId?: string, input: Record<string, unknown> = {}): Promise<{ result: unknown } | null> {
  const local = getCurrentCoreTargetId() === 'local'
  if (local && !getLocalCoreClient() && process.env.PROFER_CORE_LOCAL !== '1') return null
  const client = local ? getLocalCoreClient() : getActiveCoreClient(), coreId = local ? 'local' : currentCoreId(), generation = getCoreTargetGeneration()
  if (!client || !coreId) throw new Error('当前远程内核未连接')
  const remote = sessionId === undefined ? undefined : local ? { coreId: 'local', sessionId } : parseCoreSessionId(sessionId)
  if (sessionId !== undefined && (!remote || remote.coreId !== coreId)) throw new Error('Goal会话不属于当前Core')
  const ensureCurrent = () => {
    if ((local ? getLocalCoreClient() : getActiveCoreClient()) !== client || (!local && currentCoreId() !== coreId) || getCoreTargetGeneration() !== generation) throw new Error('Core已切换，忽略旧Goal响应')
  }
  const project = (goal: AgentGoalState) => ({ ...goal, sessionId: local ? goal.sessionId : namespaceCoreSessionId(goal.sessionId, coreId) })
  let result: unknown
  if (operation === 'start') result = await client.goalRequest('start', { ...input, sessionId: remote!.sessionId })
  else if (operation === 'list') result = await client.goalRequest('list')
  else if (operation === 'history') result = await client.goalRequest('history', { ...(remote ? { sessionId: remote.sessionId } : {}) })
  else {
    const goals = await client.listGoals(remote!.sessionId)
    ensureCurrent()
    const goal = goals[0]
    if (operation === 'get') return { result: goal ? project(goal) : null }
    if (!goal) throw new Error('此Core会话没有Goal')
    result = await client.goalRequest(operation, { ...input, goalId: goal.id })
  }
  ensureCurrent()
  return { result: Array.isArray(result) ? result.map(goal => project(goal as AgentGoalState))
    : result && typeof result === 'object' && 'sessionId' in result ? project(result as AgentGoalState) : result }
}
