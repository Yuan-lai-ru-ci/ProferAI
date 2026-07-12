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
  ForceLayoutOptions,
  ForceLayoutResult,
  ForkEdgeLayout,
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

  // 最近取消的 Task（按更新时间倒序，最多 3 个，用于打断后提醒）
  const recentCancelled = nodes
    .filter(n => n.status === 'cancelled')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map(toRecentCompleted)

  return {
    totalTasks: nodes.length,
    statusCounts,
    nextPending,
    recentCompleted,
    recentCancelled,
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
  const { total, completed, inProgress, pending, failed, cancelled } = {
    total: summary.totalTasks,
    completed: summary.statusCounts['completed'] ?? 0,
    inProgress: summary.statusCounts['in_progress'] ?? 0,
    pending: summary.statusCounts['pending'] ?? 0,
    failed: summary.statusCounts['failed'] ?? 0,
    cancelled: summary.statusCounts['cancelled'] ?? 0,
  }

  lines.push(`你已经在这个项目中规划了 ${total} 个任务。`)
  lines.push(`其中 ${completed} 个已完成${inProgress > 0 ? `，${inProgress} 个正在进行中` : ''}，${pending} 个待处理。`)

  if (failed > 0) {
    lines.push(`有 ${failed} 个任务遇到了问题，需要重新评估。`)
  }

  // 已取消的任务（用户手动打断/路线变更）—— 重要：告知 AI 不要恢复
  if (cancelled > 0) {
    lines.push(`\n⚠️ 有 ${cancelled} 个任务已被用户手动取消（通常意味着方向变更）：`)
    for (const task of summary.recentCancelled) {
      lines.push(`- ${task.subject}（已废弃，不要恢复）`)
    }
    lines.push('如果用户表达了新方向，请创建新任务并用 @forkFrom 标记分叉来源。')
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

// ===== 力导向布局（知识图谱风格） =====

/** 默认力导向布局参数 */
const DEFAULT_FORCE_OPTIONS: Required<ForceLayoutOptions> = {
  iterations: 300,
  repulsionStrength: 5000,
  attractionStrength: 0.01,
  edgeLength: 200,
  dagDirectionStrength: 0.1,
  centerGravity: 0.05,
}

/** 内部速度状态 */
interface VelocityState {
  vx: number
  vy: number
}

/**
 * 计算拓扑深度（最长路径层数）。
 * depth 0 = 无依赖根节点，depth N = max(依赖的 depth) + 1
 */
function computeTopologicalDepth(graph: TaskGraph): Map<string, number> {
  const depthMap = new Map<string, number>()

  function getDepth(nodeId: string, visited: Set<string>): number {
    const cached = depthMap.get(nodeId)
    if (cached !== undefined) return cached

    if (visited.has(nodeId)) return 0 // 防止循环依赖
    visited.add(nodeId)

    const node = graph.nodes[nodeId]
    if (!node) return 0

    if (node.dependsOn.length === 0) {
      depthMap.set(nodeId, 0)
      return 0
    }

    let maxDepth = 0
    for (const depId of node.dependsOn) {
      maxDepth = Math.max(maxDepth, getDepth(depId, new Set(visited)))
    }

    const depth = maxDepth + 1
    depthMap.set(nodeId, depth)
    return depth
  }

  for (const id of Object.keys(graph.nodes)) {
    getDepth(id, new Set())
  }

  return depthMap
}

/**
 * 力导向布局算法。
 *
 * 结合库仑斥力、弹簧引力、DAG 方向力 + 温度退火 + 速度阻尼，
 * 产生类似知识图谱的自由 2D 布局：
 * 1. 库仑斥力 — 所有节点互相推开，避免重叠
 * 2. 弹簧引力 — 有边连接的节点互相拉近
 * 3. DAG 方向力 — 基于拓扑深度，浅层推左、深层推右
 * 4. 速度阻尼 — 每次迭代衰减速度，确保收敛稳定
 */
export function computeForceLayout(
  graph: TaskGraph,
  options?: ForceLayoutOptions,
): ForceLayoutResult {
  const opts = { ...DEFAULT_FORCE_OPTIONS, ...options }
  const nodes = Object.values(graph.nodes)
  if (nodes.length === 0) {
    return {
      positions: new Map(),
      canvasWidth: 800,
      canvasHeight: 600,
      iterations: 0,
    }
  }

  // 1. 计算拓扑深度，用于种子布局和 DAG 方向力
  const depthMap = computeTopologicalDepth(graph)
  const maxDepth = Math.max(1, ...depthMap.values())

  // 2. 初始化位置：基于拓扑深度做种子布局 + 随机偏移
  const positions = new Map<string, { x: number; y: number }>()
  const velocities = new Map<string, VelocityState>()

  // 按深度分组
  const depthGroups = new Map<number, string[]>()
  for (const [id, depth] of depthMap) {
    const list = depthGroups.get(depth) || []
    list.push(id)
    depthGroups.set(depth, list)
  }

  const seedSpacingX = opts.edgeLength * 1.5
  const seedSpacingY = 120
  const seedOriginX = 100
  const seedOriginY = 100

  for (let d = 0; d <= maxDepth; d++) {
    const group = depthGroups.get(d) || []
    const totalH = (group.length - 1) * seedSpacingY
    const startY = seedOriginY + Math.max(0, (nodes.length * seedSpacingY / maxDepth - totalH) / 2)
    group.forEach((id, i) => {
      positions.set(id, {
        x: seedOriginX + d * seedSpacingX + (Math.random() - 0.5) * 40,
        y: startY + i * seedSpacingY + (Math.random() - 0.5) * 20,
      })
      velocities.set(id, { vx: 0, vy: 0 })
    })
  }

  // 3. 构建有效边列表（依赖边 + 分叉边）
  interface SimEdge {
    source: string
    target: string
    isFork: boolean
  }
  const simEdges: SimEdge[] = []
  for (const e of graph.edges) {
    simEdges.push({ source: e.from, target: e.to, isFork: false })
  }
  for (const fe of graph.forkEdges) {
    simEdges.push({ source: fe.from, target: fe.to, isFork: true })
  }

  // 4. 迭代模拟
  const totalIterations = opts.iterations

  for (let iter = 0; iter < totalIterations; iter++) {
    const alpha = 1 - iter / totalIterations // 温度退火

    // 4a. 库仑斥力（所有节点对）
    const nodeIds = Array.from(positions.keys())
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const aId = nodeIds[i]!
        const bId = nodeIds[j]!
        const a = positions.get(aId)!
        const b = positions.get(bId)!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const force = (opts.repulsionStrength * alpha) / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        // a 被推开（远离 b）
        velocities.get(aId)!.vx -= fx
        velocities.get(aId)!.vy -= fy
        // b 被推开（远离 a）
        velocities.get(bId)!.vx += fx
        velocities.get(bId)!.vy += fy
      }
    }

    // 4b. 弹簧引力（沿边）
    for (const edge of simEdges) {
      const src = positions.get(edge.source)
      const tgt = positions.get(edge.target)
      if (!src || !tgt) continue
      const dx = tgt.x - src.x
      const dy = tgt.y - src.y
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const displacement = dist - opts.edgeLength
      const force = opts.attractionStrength * displacement * alpha
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      velocities.get(edge.source)!.vx += fx
      velocities.get(edge.source)!.vy += fy
      velocities.get(edge.target)!.vx -= fx
      velocities.get(edge.target)!.vy -= fy
    }

    // 4c. DAG 方向力（基于拓扑深度）
    for (const [id, pos] of positions) {
      const depth = depthMap.get(id) ?? 0
      // 目标 x 位置：深度越大越靠右
      const targetX = seedOriginX + depth * seedSpacingX
      const dx = targetX - pos.x
      velocities.get(id)!.vx += dx * opts.dagDirectionStrength * alpha
    }

    // 4d. 速度阻尼（收敛稳定）
    for (const [, vel] of velocities) {
      vel.vx *= 0.95
      vel.vy *= 0.95
    }

    // 4e. 应用速度
    for (const [id, vel] of velocities) {
      const pos = positions.get(id)!
      pos.x += vel.vx
      pos.y += vel.vy
    }
  }

  // 5. 计算包围盒
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const pos of positions.values()) {
    minX = Math.min(minX, pos.x)
    minY = Math.min(minY, pos.y)
    maxX = Math.max(maxX, pos.x)
    maxY = Math.max(maxY, pos.y)
  }
  const pad = 150
  const canvasWidth = Math.max(800, maxX - minX + pad * 2)
  const canvasHeight = Math.max(600, maxY - minY + pad * 2)

  // 平移使所有坐标为正
  for (const pos of positions.values()) {
    pos.x = pos.x - minX + pad
    pos.y = pos.y - minY + pad
  }

  return { positions, canvasWidth, canvasHeight, iterations: totalIterations }
}

/**
 * 为分叉边计算渲染布局数据。
 *
 * 分叉边从源节点底部出发、到达目标节点顶部，使用虚线样式。
 */
export function computeForkEdgesLayout(
  graph: TaskGraph,
  positions: Map<string, { x: number; y: number }>,
  nodeW: number,
  nodeH: number,
): ForkEdgeLayout[] {
  const FORK_LINE_COLOR = '#fbbf24' // amber-400

  return graph.forkEdges.map((fe): ForkEdgeLayout | null => {
    const fromPos = positions.get(fe.from)
    const toPos = positions.get(fe.to)
    if (!fromPos || !toPos) return null

    // 源节点底部中心 → 目标节点顶部中心
    const x1 = fromPos.x + nodeW / 2
    const y1 = fromPos.y + nodeH
    const x2 = toPos.x + nodeW / 2
    const y2 = toPos.y

    // 贝塞尔曲线：向下弯曲
    const midY = (y1 + y2) / 2
    const offsetY = Math.min(60, Math.abs(y2 - y1) * 0.4)
    const d = `M ${x1} ${y1} C ${x1} ${y1 + offsetY}, ${x2} ${y2 - offsetY}, ${x2} ${y2}`

    return {
      from: fe.from,
      to: fe.to,
      reason: fe.reason,
      x1, y1, x2, y2,
      d,
      lineColor: FORK_LINE_COLOR,
    }
  }).filter((e): e is ForkEdgeLayout => e !== null)
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
