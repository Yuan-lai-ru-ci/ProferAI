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
import { atomFamily } from 'jotai/utils'
import { deriveGraph, type TaskGraph, type GraphSummary, generateSummary } from '@profer/project-core'
import { agentStreamingStatesAtom, type ToolActivity } from './agent-atoms'
import { currentAgentSessionIdAtom } from './agent-atoms'
import { aggregateTaskItems } from '@/components/agent/task-progress'

/**
 * IPC 回退层：流式结束后从 JSONL 加载的持久化 TaskGraph。
 * 由 AgentView 在 streaming→false 时触发 IPC getGraph 并写入。
 *
 * 按 sessionId 切片：每个会话各存一份持久图，避免全局单值 atom 在切换/新开
 * 会话时把上一个会话的图带过去、甚至覆盖（表现为任务图到处飞、新对话仍显示旧任务）。
 */
export const persistedGraphAtomFamily = atomFamily((_sessionId: string) =>
  atom<TaskGraph | null>(null),
)

/**
 * 从当前会话的数据源派生 TaskGraph。
 *
 * 优先级：
 * 1. 流式进行中（state.running）→ 从 ToolActivity[] 实时派生（与 TaskProgressCard 数据一致，含最新状态）
 * 2. 流式结束/空闲 → 优先返回持久化图（persistedGraphAtom，含跨轮全部节点）；缺失时回退实时派生
 *
 * 关键：每次新 run 会把 state.toolActivities 重置为 []，所以实时派生图只反映「当前/最后一轮 run」。
 * 任务若跨多轮 run 创建（每条用户消息各起一次 run），只有持久化图（buildGraphFromEvents 重放 JSONL）
 * 才是完整的。若非流式时仍无脑用实时派生，就会用「最后一轮子集」盖住 JSONL 里的完整图
 * （表现为面板只剩少数节点、进度显示 1/1）。故非流式时以持久图为准。
 */
export const currentGraphAtom = atom<TaskGraph | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null

  const states = get(agentStreamingStatesAtom)
  const state = states.get(sessionId)
  const persistedGraph = get(persistedGraphAtomFamily(sessionId))

  // 实时派生图：仅反映当前 run 的 toolActivities（每次新 run 会重置），可能只是「最后一轮子集」。
  let derivedGraph: TaskGraph | null = null
  if (state) {
    const activities: ToolActivity[] = state.toolActivities
    const taskActivities = activities.filter(a =>
      a.toolName === 'TaskCreate' || a.toolName === 'TaskUpdate' || a.toolName === 'TodoWrite',
    )
    if (taskActivities.length > 0) {
      const taskItems = aggregateTaskItems(taskActivities, false)
      if (taskItems.length > 0) derivedGraph = deriveGraph(taskItems)
    }
  }

  // 流式进行中：实时派生优先（含最新状态），并合并持久化图的 session 关联字段
  // （sdkSessionId / delegationId，只在 JSONL 的 task_session_linked 事件中存在，ToolActivity 不携带）。
  if (state?.running && derivedGraph) {
    return persistedGraph ? mergeSessionLinks(derivedGraph, persistedGraph) : derivedGraph
  }

  // 流式已结束/空闲：持久化图为完整来源（含跨轮全部节点）优先，缺失时回退实时派生兜底。
  return persistedGraph ?? derivedGraph
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
