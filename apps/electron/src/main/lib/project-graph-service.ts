/**
 * project-graph-service.ts — 主进程 Project Graph 服务
 *
 * 桥接 @profer/project-core 和 Electron 主进程：
 * - 监听 SDK 事件流中的 TaskCreate/TaskUpdate
 * - 将 Graph 事件追加写入 project-{uuid}.jsonl
 * - 通过 IPC 向渲染进程提供 Graph 查询接口
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getAgentSessionsDir } from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import {
  buildGraphFromEvents,
  parseEventsFromJsonl,
  generateSummary,
  formatSummaryAsPreamble,
  findNodeById,
  findNodesByStatus,
  completionPercentage,
  createProjectMeta,
  updateTaskCounts,
  touchProject,
  completeProject,
  archiveProject,
  isProjectActive,
  isProjectCompleted,
  projectProgress,
  projectStatusLabel,
  getGraphJsonlPath,
  serializeEvent,
  type TaskGraph,
  type ProjectMeta,
  type GraphSummary,
  type TaskNode,
  type TaskStatus,
  type GraphEvent,
} from '@profer/project-core'
import type { AgentSessionMeta } from '@profer/shared'

// ===== Graph 读取 =====

/**
 * 从 JSONL 文件加载完整 Graph。
 */
export function loadGraph(sessionId: string): TaskGraph {
  const graphJsonlPath = getGraphJsonlPath(getAgentSessionsDir(), sessionId)
  if (!existsSync(graphJsonlPath)) {
    return { nodes: {}, edges: [], forkEdges: [], updatedAt: Date.now() }
  }
  const jsonl = readFileSync(graphJsonlPath, 'utf-8')
  const events = parseEventsFromJsonl(jsonl)
  return buildGraphFromEvents(events)
}

/**
 * 获取 Graph 摘要（用于 UI 面板和 Agent preamble）。
 */
export function getGraphSummary(sessionId: string): GraphSummary {
  const graph = loadGraph(sessionId)
  return generateSummary(graph)
}

/**
 * 生成 Agent 恢复用的 preamble 文本。
 */
export function getProjectPreamble(sessionId: string): string {
  const summary = getGraphSummary(sessionId)
  if (summary.totalTasks === 0) return ''
  return formatSummaryAsPreamble(summary)
}

// ===== 节点查询 =====

/**
 * 按 ID 查找 Task 节点。
 */
export function queryNodeById(sessionId: string, taskId: string): TaskNode | null {
  const graph = loadGraph(sessionId)
  return findNodeById(graph, taskId)
}

/**
 * 按状态筛选 Task 节点。
 */
export function queryNodesByStatus(sessionId: string, status: TaskStatus): TaskNode[] {
  const graph = loadGraph(sessionId)
  return findNodesByStatus(graph, status)
}

/**
 * 获取 Graph 完成百分比。
 */
export function queryProgress(sessionId: string): number {
  const graph = loadGraph(sessionId)
  return completionPercentage(graph)
}

// ===== Project 元数据（存储在 AgentSessionMeta 扩展字段中） =====

/**
 * 为会话创建关联的 Project 元数据。
 * 由会话创建时调用（如果用户指定了项目模式）。
 */
export function initProjectMeta(sessionId: string): ProjectMeta {
  const graphJsonlPath = getGraphJsonlPath(getAgentSessionsDir(), sessionId)
  return createProjectMeta(sessionId, graphJsonlPath)
}

/**
 * 从 Graph 当前状态更新 Project 元数据的计数字段。
 */
export function syncProjectMetaFromGraph(meta: ProjectMeta, sessionId: string): ProjectMeta {
  const graph = loadGraph(sessionId)
  const totalTasks = Object.keys(graph.nodes).length
  const completedTasks = Object.values(graph.nodes).filter(
    n => n.status === 'completed',
  ).length
  return updateTaskCounts(touchProject(meta), totalTasks, completedTasks)
}

// ===== Project 级别：跨会话 Graph 聚合 =====

/**
 * 获取与指定会话属于同一项目的所有会话 ID。
 *
 * 策略：
 * 1. 查找该会话的 rootSessionId（委派链顶端）
 * 2. 如无，使用该会话自身的 parentSessionId（父会话）
 * 3. 如无，该会话自身即为根
 * 4. 扫描所有会话，找出 rootSessionId 或 parentSessionId 指向同一根的会话
 */
export function getProjectRelatedSessionIds(sessionId: string): string[] {
  const allSessions = listAgentSessions()
  const targetMeta = allSessions.find(s => s.id === sessionId)
  if (!targetMeta) return [sessionId]

  // 确定项目根
  const rootId = targetMeta.rootSessionId
    ?? targetMeta.parentSessionId
    ?? sessionId

  // 收集所有相关会话
  const related = new Set<string>()
  related.add(rootId) // 根会话
  related.add(sessionId) // 当前会话

  for (const s of allSessions) {
    if (s.id === rootId) continue
    // 子会话：rootSessionId 或 parentSessionId 指向根
    if (s.rootSessionId === rootId || s.parentSessionId === rootId) {
      related.add(s.id)
    }
  }

  return Array.from(related)
}

/**
 * 加载项目级 Graph：聚合项目下所有相关会话的 Graph 事件。
 *
 * 合并策略：
 * 1. 找出所有相关会话
 * 2. 逐个加载各会话的 {sessionId}-graph.jsonl
 * 3. 所有事件按时间戳排序
 * 4. buildGraphFromEvents 重建统一 Graph
 *
 * 节点会标注其来源会话（sourceSessionId），
 * 以便 UI 层显示 "来自会话 X" 并提供跳转。
 */
export function loadProjectGraph(sessionId: string): TaskGraph {
  const relatedIds = getProjectRelatedSessionIds(sessionId)
  const allEvents: GraphEvent[] = []

  for (const sid of relatedIds) {
    const graphJsonlPath = getGraphJsonlPath(getAgentSessionsDir(), sid)
    if (!existsSync(graphJsonlPath)) continue
    try {
      const jsonl = readFileSync(graphJsonlPath, 'utf-8')
      const events = parseEventsFromJsonl(jsonl)
      allEvents.push(...events)
    } catch {
      // 忽略损坏的 JSONL 文件
    }
  }

  // 按时间戳排序
  allEvents.sort((a, b) => a.timestamp - b.timestamp)

  const graph = buildGraphFromEvents(allEvents)

  // 标注来源会话
  const sessionIdByTask = new Map<string, string>()
  for (const event of allEvents) {
    if (event.type === 'task_created' || event.type === 'task_status_changed') {
      if (!sessionIdByTask.has(event.taskId)) {
        const sid = findSessionForTask(event.taskId, relatedIds)
        if (sid !== undefined) sessionIdByTask.set(event.taskId, sid)
      }
    }
  }

  const annotatedNodes: Record<string, TaskNode> = {}
  for (const [id, node] of Object.entries(graph.nodes)) {
    annotatedNodes[id] = {
      ...node,
      sdkSessionId: node.sdkSessionId ?? sessionIdByTask.get(id),
    }
  }

  return { ...graph, nodes: annotatedNodes, updatedAt: Date.now() }
}

/** 查找 task 属于哪个会话（通过检查各会话的 JSONL） */
function findSessionForTask(taskId: string, sessionIds: string[]): string | undefined {
  for (const sid of sessionIds) {
    const path = getGraphJsonlPath(getAgentSessionsDir(), sid)
    if (!existsSync(path)) continue
    try {
      const jsonl = readFileSync(path, 'utf-8')
      if (jsonl.includes(`"${taskId}"`)) return sid
    } catch {
      // skip
    }
  }
  return undefined
}

/**
 * 获取项目级 Graph 摘要（跨会话聚合）。
 */
export function getProjectGraphSummary(sessionId: string): GraphSummary {
  const graph = loadProjectGraph(sessionId)
  return generateSummary(graph)
}

/**
 * 生成项目级 Agent preamble。
 */
export function getProjectPreambleForSession(sessionId: string): string {
  const summary = getProjectGraphSummary(sessionId)
  if (summary.totalTasks === 0) return ''
  return formatSummaryAsPreamble(summary)
}

// ===== Graph 写入 =====

/**
 * 将单个 GraphEvent 追加写入 JSONL 文件。
 * 自动创建目录（如果不存在）。
 */
export function appendGraphEvent(sessionId: string, event: GraphEvent): void {
  const graphJsonlPath = getGraphJsonlPath(getAgentSessionsDir(), sessionId)
  const dir = dirname(graphJsonlPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const line = serializeEvent(event)
  appendFileSync(graphJsonlPath, line + '\n', 'utf-8')
}

