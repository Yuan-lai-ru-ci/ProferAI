/**
 * graph-atoms.ts — Graph 数据 Jotai atoms
 *
 * 双数据源架构：
 * 1. 流式进行中：从 agentStreamingStatesAtom 的 ToolActivity[] 实时派生 TaskGraph
 * 2. 流式结束后：回退到 IPC 从 JSONL 加载的持久化 Graph
 *
 * 数据源和 TaskProgressCard 完全一致，保证任务命名正确。
 */

import { atom } from 'jotai'
import { deriveGraph, type TaskGraph, type GraphSummary, generateSummary } from '@proma/project-core'
import { agentStreamingStatesAtom, type ToolActivity } from './agent-atoms'
import { currentAgentSessionIdAtom } from './agent-atoms'
import { aggregateTaskItems } from '@/components/agent/task-progress'

/**
 * IPC 回退层：流式结束后从 JSONL 加载的持久化 TaskGraph。
 * 由 AgentView 在 streaming→false 时触发 IPC getGraph 并写入此 atom。
 */
export const persistedGraphAtom = atom<TaskGraph | null>(null)

/**
 * 从当前会话的数据源派生 TaskGraph。
 *
 * 优先级：
 * 1. 流式进行中 → 从 ToolActivity[] 实时派生（与 TaskProgressCard 数据一致）
 * 2. 流式结束后 → 回退到 persistedGraphAtom（IPC 从 JSONL 加载）
 */
export const currentGraphAtom = atom<TaskGraph | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null

  const states = get(agentStreamingStatesAtom)
  const state = states.get(sessionId)
  const persistedGraph = get(persistedGraphAtom)

  if (state) {
    const activities: ToolActivity[] = state.toolActivities
    const taskActivities = activities.filter(a =>
      a.toolName === 'TaskCreate' || a.toolName === 'TaskUpdate' || a.toolName === 'TodoWrite',
    )
    if (taskActivities.length > 0) {
      const taskItems = aggregateTaskItems(taskActivities, false)
      if (taskItems.length > 0) {
        const derivedGraph = deriveGraph(taskItems)
        // 合并持久化图中的 session 关联信息（sdkSessionId / delegationId），
        // 这些字段只在 JSONL 的 task_session_linked 事件中存在，ToolActivity 不会携带。
        if (persistedGraph) {
          return mergeSessionLinks(derivedGraph, persistedGraph)
        }
        return derivedGraph
      }
    }
  }

  // 流式已结束或无流式活动 → 回退到 IPC 加载的持久化数据
  return persistedGraph
})

/**
 * 将持久化图中的 session 关联字段合并到流式派生图中。
 * 流式派生图只有基础字段（id/subject/status），缺少 sdkSessionId/delegationId。
 */
function mergeSessionLinks(derived: TaskGraph, persisted: TaskGraph): TaskGraph {
  const nodes = { ...derived.nodes }
  for (const [id, pNode] of Object.entries(persisted.nodes)) {
    const dNode = nodes[id]
    if (!dNode) continue
    if (pNode.sdkSessionId || pNode.delegationId) {
      nodes[id] = {
        ...dNode,
        ...(pNode.sdkSessionId && { sdkSessionId: pNode.sdkSessionId }),
        ...(pNode.delegationId && { delegationId: pNode.delegationId }),
      }
    }
  }
  return { ...derived, nodes }
}

/** Graph 摘要（供 ToolbarGraphButton 使用） */
export const currentGraphSummaryAtom = atom<GraphSummary | null>((get) => {
  const graph = get(currentGraphAtom)
  if (!graph) return null
  return generateSummary(graph)
})
