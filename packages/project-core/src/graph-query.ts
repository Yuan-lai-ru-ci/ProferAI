/**
 * graph-query.ts — Graph 查询接口
 *
 * 提供常用的 Graph 查询操作：摘要生成、下一批就绪 Task、
 * 节点查找、进度统计等。
 *
 * 所有函数均为纯函数，不修改输入 Graph。
 */

import type {
  TaskGraph,
  TaskNode,
  GraphSummary,
  RecentCompletedTask,
  TaskStatus,
  LayoutLevel,
  LayoutResult,
  TaskItemInput,
} from './types'
import { getReadyTasks, topologicalSort, ensureSequentialEdges } from './graph-state'
import { parseDependsOn, parseForkFrom, stripMetaTags } from './graph-parser'

// ===== 摘要 =====

/**
 * 生成 Graph 摘要，用于项目概览和 Agent preamble 注入。
 *
 * 摘要控制在 ~500 token 以内，包含：
 * - 整体进度计数
 * - 下一批就绪的 pending Task
 * - 最近完成的 Task（最多 3 个）及其产出物
 */
export function generateSummary(graph: TaskGraph): GraphSummary {
  const nodes = Object.values(graph.nodes)
  const statusCounts = countByStatus(nodes)

  // 找出下一个待执行的 Task（所有依赖已满足，按创建时间排序）
  const nextPending = getReadyTasks(graph)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 5) // 最多 5 个，避免 token 爆炸

  // 最近完成的 Task（按更新时间倒序，最多 3 个）
  const recentCompleted = nodes
    .filter(n => n.status === 'completed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map(toRecentCompleted)

  return {
    totalTasks: nodes.length,
    statusCounts,
    nextPending,
    recentCompleted,
  }
}

/**
 * 将 Graph 摘要格式化为 Agent preamble 文本（~300-500 token）。
 *
 * 关键约束：文本中不暴露 Graph 机制术语，
 * Agent 应像"自然记得"一样引用这些信息。
 */
export function formatSummaryAsPreamble(summary: GraphSummary): string {
  const lines: string[] = []

  // 进度概览
  const { total, completed, inProgress, pending, failed } = {
    total: summary.totalTasks,
    completed: summary.statusCounts['completed'] ?? 0,
    inProgress: summary.statusCounts['in_progress'] ?? 0,
    pending: summary.statusCounts['pending'] ?? 0,
    failed: summary.statusCounts['failed'] ?? 0,
  }

  lines.push(`你已经在这个项目中规划了 ${total} 个任务。`)
  lines.push(`其中 ${completed} 个已完成${inProgress > 0 ? `，${inProgress} 个正在进行中` : ''}，${pending} 个待处理。`)

  if (failed > 0) {
    lines.push(`有 ${failed} 个任务遇到了问题，需要重新评估。`)
  }

  // 最近完成的产出
  if (summary.recentCompleted.length > 0) {
    lines.push('\n最近完成的工作：')
    for (const task of summary.recentCompleted) {
      const artifactStr = task.artifact.length > 0
        ? `（产出：${task.artifact.join(', ')}）`
        : ''
      lines.push(`- ${task.subject}${artifactStr}`)
    }
  }

  // 下一步
  if (summary.nextPending.length > 0) {
    lines.push('\n接下来可以推进的任务：')
    for (const task of summary.nextPending) {
      lines.push(`- ${task.subject}`)
    }
  }

  lines.push('\n请自然地继续推进这些任务，就像你一直记得这些进展一样。不需要提及任何底层的追踪机制。')

  return lines.join('\n')
}

// ===== 节点查询 =====

/**
 * 按 ID 查找 Task 节点。
 */
export function findNodeById(graph: TaskGraph, taskId: string): TaskNode | null {
  return graph.nodes[taskId] ?? null
}

/**
 * 按状态筛选 Task。
 */
export function findNodesByStatus(graph: TaskGraph, status: TaskStatus): TaskNode[] {
  return Object.values(graph.nodes).filter(n => n.status === status)
}

/**
 * 获取某个 Task 的前置依赖链（包括间接依赖）。
 */
export function getDependencyChain(graph: TaskGraph, taskId: string): TaskNode[] {
  const visited = new Set<string>()
  const result: TaskNode[] = []

  function collect(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const node = graph.nodes[id]
    if (!node) return
    result.push(node)
    for (const dep of node.dependsOn) {
      collect(dep)
    }
  }

  collect(taskId)
  return result
}

// ===== 进度统计 =====

/**
 * 计算 Graph 完成百分比（0-100）。
 */
export function completionPercentage(graph: TaskGraph): number {
  const nodes = Object.values(graph.nodes)
  if (nodes.length === 0) return 0
  const completed = nodes.filter(n => n.status === 'completed').length
  return Math.round((completed / nodes.length) * 100)
}

/**
 * 获取拓扑排序后的执行计划（Kahn 算法）。
 * 复用 graph-state 中的拓扑排序。
 */
export { topologicalSort as getExecutionPlan } from './graph-state'

// ===== deriveGraph：从 TaskItem 派生 TaskGraph =====

/**
 * 从 aggregateTaskItems 产出的 TaskItem[] 派生 TaskGraph。
 * 这是 Graph 数据的主入口——命名直接复用已验证的 TaskItem.subject。
 */
export function deriveGraph(items: TaskItemInput[]): TaskGraph {
  const now = Date.now()
  const nodes: Record<string, TaskNode> = {}

  for (const item of items) {
    if (item.status === 'deleted' as never) continue
    // 元标记优先从 description 解析（prompt 指示 AI 写入 description），
    // 回退 subject 以兼容标记误写进标题的历史情况。
    const desc = item.description ?? ''
    const depFromDesc = parseDependsOn(desc)
    const dependsOn = depFromDesc.length > 0 ? depFromDesc : parseDependsOn(item.subject)
    const forkFrom = parseForkFrom(desc) ?? parseForkFrom(item.subject)
    const cleanSubject = stripMetaTags(item.subject)

    nodes[item.id] = {
      id: item.id,
      subject: cleanSubject || item.subject || item.id,
      description: stripMetaTags(desc),
      status: item.status as TaskStatus,
      dependsOn,
      dependedBy: [],
      artifact: [],
      reviewStatus: 'none',
      createdAt: now,
      updatedAt: now,
      ...(forkFrom && { forkFrom }),
    }
  }

  // 补反向边 + edges + forkEdges
  const edges: { from: string; to: string }[] = []
  const forkEdges: { from: string; to: string; reason?: string }[] = []
  for (const node of Object.values(nodes)) {
    for (const depId of node.dependsOn) {
      const dep = nodes[depId]
      if (dep && !dep.dependedBy.includes(node.id)) {
        dep.dependedBy.push(node.id)
      }
      edges.push({ from: node.id, to: depId })
    }
    // 分叉边
    if (node.forkFrom) {
      const source = nodes[node.forkFrom]
      forkEdges.push({
        from: node.forkFrom,
        to: node.id,
        reason: node.forkReason,
      })
    }
  }

  return ensureSequentialEdges({ nodes, edges, forkEdges, updatedAt: now })
}

// ===== DAG 布局 =====

/**
 * 计算 DAG 分层布局。
 *
 * 使用最长路径分层算法：
 * - level 0 = 无依赖的根节点
 * - level N = max(所有依赖的 level) + 1
 *
 * 返回按层级分组的节点，供 SVG DAG 渲染使用。
 */
export function computeLayout(graph: TaskGraph): LayoutResult {
  const nodes = Object.values(graph.nodes)
  if (nodes.length === 0) {
    return { levels: [], totalLevels: 0, maxNodesInLevel: 0 }
  }

  // 计算每个节点的层级（最长路径）
  const nodeLevels = new Map<string, number>()

  function getLevel(nodeId: string, visited: Set<string>): number {
    const cached = nodeLevels.get(nodeId)
    if (cached !== undefined) return cached

    // 防止循环依赖
    if (visited.has(nodeId)) return 0
    visited.add(nodeId)

    const node = graph.nodes[nodeId]
    if (!node) return 0

    if (node.dependsOn.length === 0) {
      nodeLevels.set(nodeId, 0)
      return 0
    }

    let maxDepLevel = 0
    for (const depId of node.dependsOn) {
      const depLevel = getLevel(depId, new Set(visited))
      maxDepLevel = Math.max(maxDepLevel, depLevel)
    }

    const level = maxDepLevel + 1
    nodeLevels.set(nodeId, level)
    return level
  }

  for (const node of nodes) {
    getLevel(node.id, new Set())
  }

  // 按层级分组
  const levelMap = new Map<number, TaskNode[]>()
  let maxLevel = 0

  for (const node of nodes) {
    const level = nodeLevels.get(node.id) ?? 0
    maxLevel = Math.max(maxLevel, level)
    const group = levelMap.get(level)
    if (group) {
      group.push(node)
    } else {
      levelMap.set(level, [node])
    }
  }

  // 构建结果（按层级排序，每层内按创建时间排序）
  const levels: LayoutLevel[] = []
  let maxNodesInLevel = 0

  for (let i = 0; i <= maxLevel; i++) {
    const levelNodes = levelMap.get(i) ?? []
    levelNodes.sort((a, b) => a.createdAt - b.createdAt)
    levels.push({ level: i, nodes: levelNodes })
    maxNodesInLevel = Math.max(maxNodesInLevel, levelNodes.length)
  }

  return { levels, totalLevels: maxLevel + 1, maxNodesInLevel }
}

// ===== Task 上下文格式化 =====

/**
 * 格式化 Task 节点为 Agent 追问时的上下文文本。
 *
 * 用于节点追问功能：用户在画板上点击某 Task 后输入反馈，
 * 此函数将 Task 的依赖关系、状态等格式化为自然语言上下文，
 * 拼接在用户消息前面一起发送给 Agent。
 */
export function formatTaskContext(node: TaskNode, graph: TaskGraph): string {
  const lines: string[] = []

  lines.push(`[用户正在查看任务图中的 Task ${node.id}：${node.subject}（当前状态：${node.status}）]`)

  if (node.dependsOn.length > 0) {
    const depNames = node.dependsOn
      .map(id => graph.nodes[id]?.subject ?? id)
      .join(', ')
    lines.push(`[该 Task 依赖：${depNames}]`)
  } else {
    lines.push(`[该 Task 依赖：无]`)
  }

  if (node.dependedBy.length > 0) {
    const depByNames = node.dependedBy
      .map(id => graph.nodes[id]?.subject ?? id)
      .join(', ')
    lines.push(`[该 Task 被依赖：${depByNames}]`)
  }

  if (node.forkFrom) {
    const sourceNode = graph.nodes[node.forkFrom]
    const sourceName = sourceNode?.subject ?? node.forkFrom
    lines.push(`[该 Task 分叉自：${sourceName}${node.forkReason ? `（原因：${node.forkReason}）` : ''}]`)
  }

  if (node.artifact.length > 0) {
    lines.push(`[已产出文件：${node.artifact.join(', ')}]`)
  }

  return lines.join('\n')
}

// ===== 内部辅助 =====

function countByStatus(nodes: TaskNode[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1
  }
  return counts
}

function toRecentCompleted(node: TaskNode): RecentCompletedTask {
  return {
    id: node.id,
    subject: node.subject,
    artifact: node.artifact,
  }
}
