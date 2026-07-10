/**
 * graph-state.ts — JSONL 事件重放，构建当前 Graph 状态
 *
 * 从 project-{uuid}.jsonl 中重放 GraphEvent 序列，
 * 重建完整的 TaskGraph 状态快照。
 *
 * 设计要点：
 * - 纯函数：输入事件数组 + 初始 Graph → 输出新 Graph
 * - 幂等：同一事件重放多次结果相同
 * - 事件按 timestamp 排序，冲突时后发生者胜
 */

import type {
  TaskGraph,
  TaskNode,
  GraphEdge,
  ForkEdge,
  GraphEvent,
  TaskUsage,
} from './types'
import { parseUsage, parseForkFrom, stripMetaTags } from './graph-parser'

// ===== 主入口 =====

/**
 * 从空 Graph 开始，重放事件列表构建完整 Graph 状态。
 */
export function buildGraphFromEvents(events: GraphEvent[]): TaskGraph {
  let graph = createEmptyGraph()

  // 确保按时间戳排序
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  for (const event of sorted) {
    graph = applyEvent(graph, event)
  }

  graph.updatedAt = sorted.length > 0
    ? sorted[sorted.length - 1]!.timestamp
    : Date.now()

  // 无显式边时自动补链式边
  return ensureSequentialEdges(graph)
}

/**
 * 将单个事件应用到当前 Graph，返回新 Graph（不可变更新）。
 */
export function applyEvent(graph: TaskGraph, event: GraphEvent): TaskGraph {
  const nodes = { ...graph.nodes }
  // 深拷贝边数组
  const edges = graph.edges.map(e => ({ ...e }))
  const forkEdges = graph.forkEdges.map(e => ({ ...e }))

  switch (event.type) {
    case 'task_created': {
      const { subject, description, dependsOn } = event.payload
      const now = event.timestamp
      // forkFrom 优先从 description 解析（prompt 指示写入 description），回退 subject
      const forkFrom = (description ? parseForkFrom(description) : null) ?? parseForkFrom(subject)
      const node: TaskNode = {
        id: event.taskId,
        subject: stripMetaTags(subject),
        description: description ? stripMetaTags(description) : description,
        status: 'pending',
        dependsOn: [...dependsOn],
        dependedBy: [],
        artifact: [],
        reviewStatus: 'none',
        createdAt: now,
        updatedAt: now,
        ...(forkFrom && { forkFrom }),
      }
      nodes[event.taskId] = node

      // 添加依赖边
      for (const dep of dependsOn) {
        edges.push({ from: event.taskId, to: dep })
        // 更新被依赖方的 dependedBy
        const depNode = nodes[dep]
        if (depNode && !depNode.dependedBy.includes(event.taskId)) {
          nodes[dep] = {
            ...depNode,
            dependedBy: [...depNode.dependedBy, event.taskId],
          }
        }
      }

      // 添加分叉边
      if (forkFrom) {
        forkEdges.push({ from: forkFrom, to: event.taskId })
      }
      break
    }

    case 'task_updated': {
      const existing = nodes[event.taskId]
      if (!existing) break
      const { subject, description } = event.payload
      const usage = description ? parseUsage(description) : null
      const forkFrom = (description ? parseForkFrom(description) : null) ?? (subject ? parseForkFrom(subject) : null)
      nodes[event.taskId] = {
        ...existing,
        ...(subject !== undefined && { subject: stripMetaTags(subject) }),
        ...(description !== undefined && { description: stripMetaTags(description) }),
        ...(usage && { usage }),
        ...(forkFrom && { forkFrom }),
        updatedAt: event.timestamp,
      }
      // 若 update 引入了分叉且边尚不存在，补 forkEdge（正常路径分叉在 task_created 已建边）
      if (forkFrom && !forkEdges.some(e => e.from === forkFrom && e.to === event.taskId)) {
        forkEdges.push({ from: forkFrom, to: event.taskId })
      }
      break
    }

    case 'task_status_changed': {
      const existing = nodes[event.taskId]
      if (existing) {
        nodes[event.taskId] = {
          ...existing,
          status: event.payload.newStatus,
          updatedAt: event.timestamp,
        }
      } else {
        // 容错：task_created 事件缺失时，从 status_changed 推断节点存在
        let fallbackSubject: string
        if (event.payload.newStatus === 'completed') fallbackSubject = `已完成: ${event.taskId}`
        else if (event.payload.newStatus === 'in_progress') fallbackSubject = `执行中: ${event.taskId}`
        else fallbackSubject = `Task ${event.taskId}`
        nodes[event.taskId] = {
          id: event.taskId,
          subject: fallbackSubject,
          description: '',
          status: event.payload.newStatus,
          dependsOn: [],
          dependedBy: [],
          artifact: [],
          reviewStatus: 'none',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
      }
      break
    }

    case 'task_dependency_added': {
      const existing = nodes[event.taskId]
      if (!existing) break
      const dep = event.payload.dependsOn
      // 避免重复添加
      if (existing.dependsOn.includes(dep)) break
      nodes[event.taskId] = {
        ...existing,
        dependsOn: [...existing.dependsOn, dep],
        updatedAt: event.timestamp,
      }
      // 添加边
      edges.push({ from: event.taskId, to: dep })
      // 更新被依赖方的 dependedBy
      const depNode = nodes[dep]
      if (depNode && !depNode.dependedBy.includes(event.taskId)) {
        nodes[dep] = {
          ...depNode,
          dependedBy: [...depNode.dependedBy, event.taskId],
        }
      }
      break
    }

    case 'task_artifact_added': {
      const existing = nodes[event.taskId]
      if (!existing) break
      const artifact = event.payload.artifact
      if (existing.artifact.includes(artifact)) break
      nodes[event.taskId] = {
        ...existing,
        artifact: [...existing.artifact, artifact],
        updatedAt: event.timestamp,
      }
      break
    }

    case 'task_session_linked': {
      const existing = nodes[event.taskId]
      if (!existing) break
      const { sessionId, childSessionId } = event.payload
      // 已关联则不重复写入
      const alreadyLinked =
        existing.sdkSessionId === sessionId ||
        (childSessionId && existing.sdkSessionId === childSessionId)
      if (alreadyLinked) break
      nodes[event.taskId] = {
        ...existing,
        // 如果是协作委派：delegationId 记录委派 ID，sdkSessionId 记录实际可导航的子会话 ID
        // 否则 sessionId 本身就是可导航的 SDK session ID
        ...(childSessionId
          ? { delegationId: sessionId, sdkSessionId: childSessionId }
          : { sdkSessionId: sessionId }),
        updatedAt: event.timestamp,
      }
      break
    }
  }

  return { nodes, edges, forkEdges, updatedAt: event.timestamp }
}

/**
 * 创建空的 TaskGraph。
 */
export function createEmptyGraph(): TaskGraph {
  return { nodes: {}, edges: [], forkEdges: [], updatedAt: Date.now() }
}

/**
 * 对没有显式边的 Graph 自动补链式边（按创建时间排序）。
 * 补充 @dependsOn 标记被 Agent 忽略时的兜底。
 */
export function ensureSequentialEdges(graph: TaskGraph): TaskGraph {
  // 已有显式边则不干预
  if (graph.edges.length > 0) return graph

  const sorted = Object.values(graph.nodes).sort((a, b) => a.createdAt - b.createdAt)
  if (sorted.length < 2) return graph

  const newEdges: GraphEdge[] = []
  for (let i = 1; i < sorted.length; i++) {
    newEdges.push({ from: sorted[i]!.id, to: sorted[i - 1]!.id })
    // 同时更新节点的 dependsOn / dependedBy
    sorted[i]!.dependsOn.push(sorted[i - 1]!.id)
    sorted[i - 1]!.dependedBy.push(sorted[i]!.id)
  }

  return { ...graph, edges: [...graph.edges, ...newEdges] }
}

// ===== 节点辅助函数 =====

/**
 * 检查 Task 是否可以开始执行（所有依赖已完成）。
 */
export function isTaskReady(node: TaskNode, graph: TaskGraph): boolean {
  if (node.status !== 'pending') return false
  return node.dependsOn.every(depId => {
    const depNode = graph.nodes[depId]
    return depNode && depNode.status === 'completed'
  })
}

/**
 * 获取 Graph 中所有可以开始执行的 Task。
 */
export function getReadyTasks(graph: TaskGraph): TaskNode[] {
  return Object.values(graph.nodes).filter(n => isTaskReady(n, graph))
}

/**
 * 获取按拓扑排序的 Task 列表（用于顺序执行）。
 * Kahn 算法实现。
 */
export function topologicalSort(graph: TaskGraph): TaskNode[] {
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const nodeIds = Object.keys(graph.nodes)

  // 初始化
  for (const id of nodeIds) {
    inDegree.set(id, graph.nodes[id]!.dependsOn.length)
    adj.set(id, [])
  }

  // 构建邻接表（反向：被依赖方 → 依赖方）
  for (const edge of graph.edges) {
    const list = adj.get(edge.to)
    if (list) list.push(edge.from)
  }

  // Kahn 算法
  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const result: TaskNode[] = []
  while (queue.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const id = queue.shift()!
    const node = graph.nodes[id]
    if (node) result.push(node)

    const neighbors = adj.get(id) ?? []
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  return result
}

// ===== 序列化 =====

/**
 * 将 GraphEvent 序列化为 JSONL 行。
 */
export function serializeEvent(event: GraphEvent): string {
  return JSON.stringify(event)
}

/**
 * 从 JSONL 行反序列化 GraphEvent。
 */
export function deserializeEvent(line: string): GraphEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (
      typeof parsed['type'] !== 'string' ||
      typeof parsed['timestamp'] !== 'number' ||
      typeof parsed['taskId'] !== 'string' ||
      parsed['payload'] == null
    ) {
      return null
    }
    // 类型已在 JSON Schema 层面验证，此处信任存储层
    return parsed as unknown as GraphEvent
  } catch {
    return null
  }
}

/**
 * 从多行 JSONL 文本解析 GraphEvent 列表。
 */
export function parseEventsFromJsonl(jsonl: string): GraphEvent[] {
  return jsonl
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(deserializeEvent)
    .filter((e): e is GraphEvent => e !== null)
}
