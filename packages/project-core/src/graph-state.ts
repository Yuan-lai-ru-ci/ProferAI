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
import { parseArtifact, parseUsage, parseForkFrom, parseAbandon, parseDependsOn, stripMetaTags } from './graph-parser'

// ===== 主入口 =====

/**
 * 全局一致性修复：从 edges 重建所有节点的 dependedBy 反向引用。
 *
 * 事件可能因乱序而导致 depNode 在 dependency 添加时尚未创建，
 * 此函数确保 dependedBy 与 edges 完全一致。
 */
function reconcileDependedBy(graph: TaskGraph): TaskGraph {
  const nodes: Record<string, TaskNode> = {}
  for (const id of Object.keys(graph.nodes)) {
    nodes[id] = { ...graph.nodes[id]!, dependedBy: [] }
  }
  for (const edge of graph.edges) {
    const target = nodes[edge.to]
    if (target && !target.dependedBy.includes(edge.from)) {
      nodes[edge.to] = {
        ...target,
        dependedBy: [...target.dependedBy, edge.from],
      }
    }
  }
  return { ...graph, nodes }
}

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

  // 全局 reconcile：修复因事件乱序导致的 dependedBy 丢失
  graph = reconcileDependedBy(graph)

  graph.updatedAt = sorted.length > 0
    ? sorted[sorted.length - 1]!.timestamp
    : Date.now()

  return graph
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
      const { subject, description, dependsOn, forkFrom: explicitForkFrom } = event.payload
      const now = event.timestamp
      // 结构化字段优先；旧事件仍可从 description 或 subject 回放分叉关系。
      const forkFrom = explicitForkFrom ?? (description ? parseForkFrom(description) : null) ?? parseForkFrom(subject)
      const artifactFromDescription = description ? parseArtifact(description) : []
      const artifact = artifactFromDescription.length > 0 ? artifactFromDescription : parseArtifact(subject)
      const usage = (description ? parseUsage(description) : null) ?? parseUsage(subject)
      const abandonReason = (description ? parseAbandon(description) : null) ?? parseAbandon(subject)
      const node: TaskNode = {
        id: event.taskId,
        subject: stripMetaTags(subject),
        description: description ? stripMetaTags(description) : description,
        status: abandonReason ? 'cancelled' : 'pending',
        dependsOn: [...dependsOn],
        dependedBy: [],
        artifact,
        reviewStatus: 'none',
        createdAt: now,
        updatedAt: now,
        ...(usage && { usage }),
        ...(forkFrom && { forkFrom }),
        ...(abandonReason && { abandonReason, abandonConfidence: 1, abandonEvidence: [] }),
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
      if (forkFrom && nodes[forkFrom]) {
        forkEdges.push({ from: forkFrom, to: event.taskId })
      }
      break
    }

    case 'task_updated': {
      const existing = nodes[event.taskId]
      if (!existing) break
      const { subject, description, dependsOn: explicitDependsOn, forkFrom: explicitForkFrom } = event.payload
      const artifacts = description ? parseArtifact(description) : []
      const usage = description ? parseUsage(description) : null
      const forkFrom = explicitForkFrom ?? (description ? parseForkFrom(description) : null) ?? (subject ? parseForkFrom(subject) : null)

      // 结构化 dependsOn（包括 []）和 description 中的标记都是权威完整列表。
      // subject 中的只是兜底 → 合并。这样 Agent 移除某个依赖时边也会同步消失。
      const dependsOnFromDescription = description ? parseDependsOn(description) : []
      const dependsOnFromSubject = subject ? parseDependsOn(subject) : []
      const hasExplicitDependsOn = explicitDependsOn !== undefined || dependsOnFromDescription.length > 0
      const newDependsOn = explicitDependsOn
        ?? (dependsOnFromDescription.length > 0
          ? dependsOnFromDescription
          : dependsOnFromSubject)

      // 显式替换：清理被移除的旧边 + 被依赖方的 dependedBy
      if (hasExplicitDependsOn) {
        const removed = existing.dependsOn.filter((d) => !newDependsOn.includes(d))
        for (const oldDep of removed) {
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i]!.from === event.taskId && edges[i]!.to === oldDep) {
              edges.splice(i, 1)
            }
          }
          const oldDepNode = nodes[oldDep]
          if (oldDepNode) {
            nodes[oldDep] = {
              ...oldDepNode,
              dependedBy: oldDepNode.dependedBy.filter((id) => id !== event.taskId),
            }
          }
        }
      }

      const finalDependsOn = hasExplicitDependsOn
        ? newDependsOn
        : (newDependsOn.length > 0
          ? [...new Set([...existing.dependsOn, ...newDependsOn])]
          : existing.dependsOn)

      nodes[event.taskId] = {
        ...existing,
        ...(subject !== undefined && { subject: stripMetaTags(subject) }),
        ...(description !== undefined && { description: stripMetaTags(description) }),
        ...(hasExplicitDependsOn && { dependsOn: finalDependsOn }),
        ...(artifacts.length > 0 && { artifact: [...new Set([...existing.artifact, ...artifacts])] }),
        ...(usage && { usage }),
        ...(forkFrom && { forkFrom }),
        updatedAt: event.timestamp,
      }

      // 添加新边（旧边清理已在上面完成，这里只加不重复的）
      for (const dep of newDependsOn) {
        if (!edges.some((e) => e.from === event.taskId && e.to === dep)) {
          edges.push({ from: event.taskId, to: dep })
        }
        const depNode = nodes[dep]
        if (depNode && !depNode.dependedBy.includes(event.taskId)) {
          nodes[dep] = {
            ...depNode,
            dependedBy: [...depNode.dependedBy, event.taskId],
          }
        }
      }
      if (forkFrom) {
        for (let i = forkEdges.length - 1; i >= 0; i--) {
          if (forkEdges[i]!.to === event.taskId) forkEdges.splice(i, 1)
        }
        if (nodes[forkFrom]) {
          forkEdges.push({ from: forkFrom, to: event.taskId })
        }
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
        // 容错：task_created 事件缺失时，从已有 edges 中恢复该节点的依赖关系，
        // 避免创建零连接的孤立节点
        let fallbackSubject: string
        if (event.payload.newStatus === 'completed') fallbackSubject = `已完成: ${event.taskId}`
        else if (event.payload.newStatus === 'in_progress') fallbackSubject = `执行中: ${event.taskId}`
        else fallbackSubject = `Task ${event.taskId}`

        // 从已有边中恢复连接关系（之前 task_dependency_added 可能已为它建了边）
        const recoveredDependsOn: string[] = []
        const recoveredDependedBy: string[] = []
        for (const edge of edges) {
          if (edge.from === event.taskId && !recoveredDependsOn.includes(edge.to))
            recoveredDependsOn.push(edge.to)
          if (edge.to === event.taskId && !recoveredDependedBy.includes(edge.from))
            recoveredDependedBy.push(edge.from)
        }

        nodes[event.taskId] = {
          id: event.taskId,
          subject: fallbackSubject,
          description: '',
          status: event.payload.newStatus,
          dependsOn: recoveredDependsOn,
          dependedBy: recoveredDependedBy,
          artifact: [],
          reviewStatus: 'none',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
      }
      break
    }

    case 'task_dependency_added': {
      let existing = nodes[event.taskId]
      // 源节点不存在时创建 fallback，避免依赖事件被静默丢弃
      if (!existing) {
        existing = {
          id: event.taskId,
          subject: `Task ${event.taskId}`,
          description: '',
          status: 'pending',
          dependsOn: [],
          dependedBy: [],
          artifact: [],
          reviewStatus: 'none',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        nodes[event.taskId] = existing
      }
      const dep = event.payload.dependsOn
      // 避免重复添加
      if (existing.dependsOn.includes(dep)) break
      nodes[event.taskId] = {
        ...existing,
        dependsOn: [...existing.dependsOn, dep],
        updatedAt: event.timestamp,
      }
      // 添加边（即使目标节点尚不存在也先加边，后续 reconcileDependedBy 会补反向引用）
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

    case 'task_abandon_annotated': {
      // 回溯抽取的放弃标注：写入放弃原因 + 证据，并把非 completed 的节点标为 cancelled（枯死支线）。
      // 纯附加、幂等：重放多次结果相同；只挂到已存在的真实节点（挂不上的在服务层降级为文字注记，不进图）。
      const existing = nodes[event.taskId]
      if (!existing) break
      const { reason, confidence, evidenceTurns } = event.payload
      nodes[event.taskId] = {
        ...existing,
        abandonReason: reason,
        abandonConfidence: confidence,
        abandonEvidence: [...evidenceTurns],
        // 保守置 cancelled：仅当当前非 completed（已完成的任务即便方向后来被放弃也保留 completed 状态）
        ...(existing.status !== 'completed' && { status: 'cancelled' as const }),
        updatedAt: event.timestamp,
      }
      break
    }

    case 'task_deleted': {
      // 真删除：把节点从图上移除，并清理所有指向它的边与依赖引用。
      // 与「放弃(abandon 枯枝，保留留痕)」「取消(cancelled，保留灰化)」区分——删除是用户/Agent
      // 显式要求"这个任务不要了、从图上拿掉"。幂等：节点已不存在仍清理悬挂引用，重放多次结果相同。
      delete nodes[event.taskId]
      // 清理其他节点对该节点的 dependsOn / dependedBy 引用
      for (const id of Object.keys(nodes)) {
        const n = nodes[id]!
        const inDeps = n.dependsOn.includes(event.taskId)
        const inDependedBy = n.dependedBy.includes(event.taskId)
        if (inDeps || inDependedBy) {
          nodes[id] = {
            ...n,
            ...(inDeps && { dependsOn: n.dependsOn.filter((d) => d !== event.taskId) }),
            ...(inDependedBy && { dependedBy: n.dependedBy.filter((d) => d !== event.taskId) }),
          }
        }
      }
      return {
        nodes,
        edges: edges.filter((e) => e.from !== event.taskId && e.to !== event.taskId),
        forkEdges: forkEdges.filter((e) => e.from !== event.taskId && e.to !== event.taskId),
        updatedAt: event.timestamp,
      }
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
