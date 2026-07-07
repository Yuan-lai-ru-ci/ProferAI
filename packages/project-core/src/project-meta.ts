/**
 * project-meta.ts — Project 元数据管理
 *
 * 管理 Project 的创建、更新、主会话绑定等操作。
 * 元数据存储在 AgentSessionMeta 的扩展字段中，
 * 由调用方（主进程 project-graph-service.ts）负责持久化。
 */

import type { ProjectMeta, ProjectStatus, SessionType } from './types'

// ===== 工厂函数 =====

/**
 * 创建新的 Project 元数据。
 *
 * @param mainSessionId - 用户直接交互的主会话 ID（权威入口）
 * @param graphJsonlPath - Graph 事件的 JSONL 文件路径
 */
export function createProjectMeta(
  mainSessionId: string,
  graphJsonlPath: string,
): ProjectMeta {
  const now = Date.now()
  return {
    projectStatus: 'active',
    mainSessionId,
    graphJsonlPath,
    totalTasks: 0,
    completedTasks: 0,
    createdAt: now,
    lastActiveAt: now,
  }
}

/**
 * 更新 Project 的任务计数。
 */
export function updateTaskCounts(
  meta: ProjectMeta,
  totalTasks: number,
  completedTasks: number,
): ProjectMeta {
  return {
    ...meta,
    totalTasks,
    completedTasks,
    lastActiveAt: Date.now(),
  }
}

/**
 * 更新 Project 的最后活跃时间。
 */
export function touchProject(meta: ProjectMeta): ProjectMeta {
  return { ...meta, lastActiveAt: Date.now() }
}

/**
 * 标记 Project 为已完成。
 */
export function completeProject(meta: ProjectMeta): ProjectMeta {
  return { ...meta, projectStatus: 'completed', lastActiveAt: Date.now() }
}

/**
 * 归档 Project。
 */
export function archiveProject(meta: ProjectMeta): ProjectMeta {
  return { ...meta, projectStatus: 'archived', lastActiveAt: Date.now() }
}

// ===== 查询 =====

/**
 * 判断会话是否为 Project 会话。
 */
export function isProjectSession(sessionType: SessionType | string | undefined): boolean {
  return sessionType === 'project'
}

/**
 * 判断 Project 是否活跃（可以继续执行）。
 */
export function isProjectActive(meta: ProjectMeta): boolean {
  return meta.projectStatus === 'active'
}

/**
 * 判断 Project 是否已完成。
 */
export function isProjectCompleted(meta: ProjectMeta): boolean {
  return meta.projectStatus === 'completed' || meta.projectStatus === 'archived'
}

// ===== Progress 计算 =====

/**
 * 计算 Project 完成百分比（0-100）。
 */
export function projectProgress(meta: ProjectMeta): number {
  if (meta.totalTasks === 0) return 0
  return Math.round((meta.completedTasks / meta.totalTasks) * 100)
}

/**
 * 生成 Project 状态的可读摘要。
 */
export function projectStatusLabel(meta: ProjectMeta): string {
  switch (meta.projectStatus) {
    case 'active':
      return meta.totalTasks > 0
        ? `进行中（${projectProgress(meta)}%）`
        : '进行中'
    case 'completed':
      return '已完成'
    case 'archived':
      return '已归档'
  }
}

// ===== 文件路径工具 =====

/**
 * 根据会话 ID 生成 Graph JSONL 文件路径。
 * 约定：与 Agent 会话 JSONL 同目录，文件名为 {sessionId}-graph.jsonl
 *
 * @param sessionDir - Agent 会话存储目录（如 ~/.proma/agent-sessions/）
 * @param sessionId - 主会话 ID
 */
export function getGraphJsonlPath(sessionDir: string, sessionId: string): string {
  // 使用 POSIX 路径拼接以保持跨平台兼容
  const normalizedDir = sessionDir.replace(/\\/g, '/')
  return `${normalizedDir}/${sessionId}-graph.jsonl`
}
