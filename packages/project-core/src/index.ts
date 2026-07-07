/**
 * @proma/project-core — Agent 项目编排 headless 核心
 *
 * 提供 Agent 任务 Graph 的构建、状态管理、查询和 Project 元数据管理。
 * 所有导出函数均为纯函数，浏览器安全。
 */

// 类型
export type {
  TaskStatus,
  ReviewStatus,
  TaskNode,
  TaskGraph,
  GraphEdge,
  ForkEdge,
  GraphEventType,
  GraphEvent,
  GraphEventPayload,
  TaskCreatedPayload,
  TaskUpdatedPayload,
  TaskStatusChangedPayload,
  TaskDependencyAddedPayload,
  TaskArtifactAddedPayload,
  TaskSessionLinkedPayload,
  SessionType,
  ProjectStatus,
  ProjectMeta,
  GraphSummary,
  RecentCompletedTask,
  ExtractGraphInput,
  LayoutLevel,
  LayoutResult,
  TaskItemInput,
} from './types'

// Graph 解析（元标记提取）
export {
  parseDependsOn,
  parseArtifact,
  parseUsage,
  parseForkFrom,
  stripMetaTags,
} from './graph-parser'

// Graph 状态
export {
  buildGraphFromEvents,
  applyEvent,
  createEmptyGraph,
  isTaskReady,
  getReadyTasks,
  topologicalSort,
  serializeEvent,
  deserializeEvent,
  parseEventsFromJsonl,
  ensureSequentialEdges,
} from './graph-state'

// Graph 查询
export {
  generateSummary,
  formatSummaryAsPreamble,
  findNodeById,
  findNodesByStatus,
  getDependencyChain,
  completionPercentage,
  getExecutionPlan,
  computeLayout,
  deriveGraph,
  formatTaskContext,
} from './graph-query'

// Project 元数据
export {
  createProjectMeta,
  updateTaskCounts,
  touchProject,
  completeProject,
  archiveProject,
  isProjectSession,
  isProjectActive,
  isProjectCompleted,
  projectProgress,
  projectStatusLabel,
  getGraphJsonlPath,
} from './project-meta'
