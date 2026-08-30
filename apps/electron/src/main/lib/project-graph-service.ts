/**
 * project-graph-service.ts — 主进程 Project Graph 服务
 *
 * 桥接 @profer/project-core 和 Electron 主进程：
 * - 监听 SDK 事件流中的 TaskCreate/TaskUpdate
 * - 将 Graph 事件追加写入 project-{uuid}.jsonl
 * - 通过 IPC 向渲染进程提供 Graph 查询接口
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { getAgentSessionsDir } from './config-paths'
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
  isSafeSessionId,
  serializeEvent,
  type TaskGraph,
  type ProjectMeta,
  type GraphSummary,
  type TaskNode,
  type TaskStatus,
  getReadyTasks,
  selectHarnessFocus,
  type GraphEvent,
} from '@profer/project-core'
import type { AgentSessionMeta } from '@profer/shared'

// ===== Graph 读取 =====

/**
 * 从 JSONL 文件加载完整 Graph。
 */
function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error('无效的会话标识')
}

/**
 * 解析并校验 Graph 文件路径。
 * 会话 ID 校验阻止路径注入；这里再拒绝已有 Graph 文件的 symlink，
 * 防止本地恶意文件把安全文件名重定向到会话目录外。
 */
function getSafeGraphPath(sessionId: string): string {
  assertSafeSessionId(sessionId)
  const sessionDir = getAgentSessionsDir()
  const graphPath = resolve(getGraphJsonlPath(sessionDir, sessionId))
  const realSessionDir = realpathSync(sessionDir)
  if (graphPath !== realSessionDir && !graphPath.startsWith(realSessionDir + sep)) {
    throw new Error('任务图路径不在会话目录内')
  }
  if (existsSync(graphPath)) {
    if (lstatSync(graphPath).isSymbolicLink()) throw new Error('任务图文件不允许使用符号链接')
    const realGraphPath = realpathSync(graphPath)
    if (realGraphPath !== realSessionDir && !realGraphPath.startsWith(realSessionDir + sep)) {
      throw new Error('任务图路径不在会话目录内')
    }
  }
  return graphPath
}

export function loadGraph(sessionId: string): TaskGraph {
  const graphJsonlPath = getSafeGraphPath(sessionId)
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
 * Loads the graph once and derives the small set of deterministic facts needed
 * by the Harness. Callers must not reload the JSONL separately for focus/ready.
 */
export function loadHarnessGraphSnapshot(sessionId: string, previousFocusTaskId?: string): {
  graph: TaskGraph
  readyTaskIds: string[]
  focusTaskId?: string
  focusReason: string
} {
  const graph = loadGraph(sessionId)
  const focus = selectHarnessFocus(graph, previousFocusTaskId)
  return {
    graph,
    readyTaskIds: getReadyTasks(graph)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((task) => task.id),
    focusTaskId: focus.task?.id,
    focusReason: focus.reason,
  }
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
  const graphJsonlPath = getSafeGraphPath(sessionId)
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

// ===== Graph 写入 =====

/**
 * 将单个 GraphEvent 追加写入 JSONL 文件。
 * 自动创建目录（如果不存在）。
 */
export function appendGraphEvent(sessionId: string, event: GraphEvent): void {
  const graphJsonlPath = getSafeGraphPath(sessionId)
  const dir = dirname(graphJsonlPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const line = serializeEvent(event)
  appendFileSync(graphJsonlPath, line + '\n', 'utf-8')
}

