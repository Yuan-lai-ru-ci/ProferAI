/**
 * graph-atoms.ts — Graph 数据 Jotai atoms
 *
 * 三数据源架构（按优先级）：
 * 1. 持久化图（JSONL 重放）— 始终作为 baseline，包含跨 run 全部历史节点
 * 2. 流式进行中 — 实时 TaskItem overlay 到 baseline 上，更新状态/标题/新增节点
 *
 * 持久化数据按 sessionId 隔离，避免切换会话时相互污染。
 *
 * 关键设计决策（2026-07-15）：
 * - 不再在"实时派生"和"持久化"之间二选一切换，改为始终以持久化为 baseline、
 *   实时 TaskItem 做 overlay。这消除了流式/持久切换时的图突变（"散掉"根因 1）。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import {
  deriveGraph,
  type TaskGraph,
  type GraphSummary,
  type TaskNode,
  type GraphEdge,
  type ForkEdge,
  generateSummary,
} from '@profer/project-core'
import { agentStreamingStatesAtom, type ToolActivity } from './agent-atoms'
import { currentAgentSessionIdAtom } from './agent-atoms'
import { aggregateTaskItems, type TaskItem } from '@/components/agent/task-progress'

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
 * 将当前 run 的实时 TaskItem[] overlay 到持久化 baseline 图上。
 *
 * - 已存在的节点：更新 status / subject / description / dependsOn（合并，只增不删）
 * - 新节点：从 deriveGraph 创建并加入
 * - 最后做 dependedBy 全局 reconcile，保证反向引用一致
 *
 * 纯函数，不修改输入。
 */
function mergeRealTimeIntoGraph(baseGraph: TaskGraph, taskItems: TaskItem[]): TaskGraph {
  if (taskItems.length === 0) return baseGraph

  const realtimeGraph = deriveGraph(taskItems)
  const nodes: Record<string, TaskNode> = { ...baseGraph.nodes }
  const now = Date.now()

  for (const [id, rtNode] of Object.entries(realtimeGraph.nodes)) {
    const existing = nodes[id]
    if (existing) {
      // 更新已有节点：实时状态/标题/描述覆盖（更当前），依赖只增不删
      nodes[id] = {
        ...existing,
        status: rtNode.status,
        subject: rtNode.subject !== existing.subject ? rtNode.subject : existing.subject,
        ...(rtNode.description !== undefined &&
          rtNode.description !== existing.description && { description: rtNode.description }),
        dependsOn: [...new Set([...existing.dependsOn, ...rtNode.dependsOn])],
        updatedAt: now,
      }
    } else {
      // 新节点：直接采用实时派生结果
      nodes[id] = rtNode
    }
  }

  // 重建边：baseline 边 + 实时 overlay 新增的依赖边 & 分叉边
  const edges: GraphEdge[] = [...baseGraph.edges]
  const forkEdges: ForkEdge[] = [...baseGraph.forkEdges]

  for (const node of Object.values(nodes)) {
    for (const depId of node.dependsOn) {
      if (!edges.some((e) => e.from === node.id && e.to === depId)) {
        edges.push({ from: node.id, to: depId })
      }
    }
    if (node.forkFrom && nodes[node.forkFrom]) {
      if (!forkEdges.some((e) => e.from === node.forkFrom && e.to === node.id)) {
        forkEdges.push({ from: node.forkFrom!, to: node.id })
      }
    }
  }

  // 全局 reconcile dependedBy，确保与 edges 一致
  const reconciledNodes: Record<string, TaskNode> = {}
  for (const id of Object.keys(nodes)) {
    reconciledNodes[id] = { ...nodes[id]!, dependedBy: [] }
  }
  for (const edge of edges) {
    const target = reconciledNodes[edge.to]
    if (target && !target.dependedBy.includes(edge.from)) {
      reconciledNodes[edge.to] = {
        ...target,
        dependedBy: [...target.dependedBy, edge.from],
      }
    }
  }

  return { nodes: reconciledNodes, edges, forkEdges, updatedAt: now }
}

/**
 * 从当前会话的数据源派生 TaskGraph。
 *
 * 始终以持久化图（JSONL 全量重放）为 baseline：
 * - 流式进行中（state.running）：baseline + 实时 TaskItem overlay（状态/新增）
 * - 流式结束/空闲：直接返回 persistedGraph（可能为 null，触发 useGraphData IPC fallback）
 *
 * 关键：非流式时返回 null 是正常的——useGraphData 的 IPC getGraph 会异步加载并写入
 * persistedGraphAtomFamily，然后此 atom 自动重算返回真实图。如果这里兜底空图 { nodes: {} }，
 * atomGraph 永不为 null，useGraphData 的 atomGraph ?? ipcGraph fallback 就永远走不到 ipcGraph。
 */
export const currentGraphAtom = atom<TaskGraph | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null

  const states = get(agentStreamingStatesAtom)
  const state = states.get(sessionId)
  const persistedGraph = get(persistedGraphAtomFamily(sessionId))

  // 流式进行中：persistedGraph 为 baseline + 实时 TaskItem overlay
  if (state?.running) {
    const baseline: TaskGraph = persistedGraph ?? {
      nodes: {},
      edges: [],
      forkEdges: [],
      updatedAt: Date.now(),
    }
    const activities: ToolActivity[] = state.toolActivities
    const taskActivities = activities.filter(
      (a) =>
        a.toolName === 'TaskCreate' ||
        a.toolName === 'TaskUpdate' ||
        a.toolName === 'TodoWrite',
    )
    if (taskActivities.length > 0) {
      const taskItems = aggregateTaskItems(taskActivities, false)
      if (taskItems.length > 0) {
        return mergeRealTimeIntoGraph(baseline, taskItems)
      }
    }
    return baseline
  }

  // 非流式：直接返回 persistedGraph。
  // null = IPC 尚未加载或会话无任务，useGraphData 会通过 api.getGraph 异步补上。
  return persistedGraph
})

/** Graph 摘要（供 ToolbarGraphButton 使用，优先项目级） */
export const currentGraphSummaryAtom = atom<GraphSummary | null>((get) => {
  const graph = get(currentGraphAtom)
  if (!graph) return null
  return generateSummary(graph)
})
