/**
 * @proma/project-core — Agent 项目编排核心类型
 *
 * 定义 Project、Graph、Node、Edge 及其状态，
 * 是 project-core 包所有模块共享的类型基础。
 */

// ===== Task 节点 =====

/** Task 状态 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** Task 审查状态（预留字段，一阶段不做强制逻辑） */
export type ReviewStatus = 'none' | 'pending_review' | 'approved' | 'needs_changes'

/** Graph 中的 Task 节点 */
export interface TaskNode {
  /** Task 唯一标识（对应 SDK TaskCreate 的 taskId） */
  id: string
  /** Task 标题 */
  subject: string
  /** Task 描述 */
  description: string
  /** 当前状态 */
  status: TaskStatus
  /** 依赖的 Task ID 列表（从 dependsOn 字段解析） */
  dependsOn: string[]
  /** 被依赖的 Task ID 列表（反向边，由 graph-state 自动计算） */
  dependedBy: string[]
  /** 产出物文件路径列表（从 artifact 字段解析） */
  artifact: string[]
  /** 审查状态 */
  reviewStatus: ReviewStatus
  /** 创建时间戳 */
  createdAt: number
  /** 最后更新时间戳 */
  updatedAt: number
  /** 关联的 SDK 会话 ID（执行该 Task 的子会话） */
  sdkSessionId?: string
  /** 关联的委派 ID（如果通过协作委派执行） */
  delegationId?: string
  /** 执行用量（token、工具调用次数、耗时） */
  usage?: TaskUsage
  /** 分叉来源 Task ID（如果是从另一个 Task 分叉出来的） */
  forkFrom?: string
  /** 分叉原因（用户反馈摘要） */
  forkReason?: string
}

/** Task 执行用量 */
export interface TaskUsage {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

// ===== Graph =====

/** Task Graph */
export interface TaskGraph {
  /** 所有 Task 节点（key 为 taskId） */
  nodes: Record<string, TaskNode>
  /** 依赖边列表（源 → 目标，表示源依赖目标完成后方可开始） */
  edges: GraphEdge[]
  /** 分叉边列表（记录 Task 分叉来源） */
  forkEdges: ForkEdge[]
  /** Graph 最后更新时间戳 */
  updatedAt: number
}

/** Graph 中的边 */
export interface GraphEdge {
  /** 源 Task ID（依赖方） */
  from: string
  /** 目标 Task ID（被依赖方） */
  to: string
}

/** 分叉边（记录 Task 分叉来源） */
export interface ForkEdge {
  /** 分叉源 Task ID */
  from: string
  /** 新 Task ID */
  to: string
  /** 分叉原因（用户反馈摘要） */
  reason?: string
}

// ===== Graph 事件（JSONL 持久化） =====

/** Graph 事件类型 */
export type GraphEventType =
  | 'task_created'
  | 'task_updated'
  | 'task_status_changed'
  | 'task_dependency_added'
  | 'task_artifact_added'
  | 'task_session_linked'

/** Graph 事件基础字段 */
interface GraphEventBase {
  /** 事件时间戳 */
  timestamp: number
  /** 关联的 Task ID */
  taskId: string
}

/** Graph 事件（追加写入 project-{uuid}.jsonl）——可判别联合体 */
export type GraphEvent =
  | (GraphEventBase & { type: 'task_created'; payload: TaskCreatedPayload })
  | (GraphEventBase & { type: 'task_updated'; payload: TaskUpdatedPayload })
  | (GraphEventBase & { type: 'task_status_changed'; payload: TaskStatusChangedPayload })
  | (GraphEventBase & { type: 'task_dependency_added'; payload: TaskDependencyAddedPayload })
  | (GraphEventBase & { type: 'task_artifact_added'; payload: TaskArtifactAddedPayload })
  | (GraphEventBase & { type: 'task_session_linked'; payload: TaskSessionLinkedPayload })

/** Graph 事件载荷联合类型 */
export type GraphEventPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskStatusChangedPayload
  | TaskDependencyAddedPayload
  | TaskArtifactAddedPayload
  | TaskSessionLinkedPayload

export interface TaskCreatedPayload {
  subject: string
  description: string
  dependsOn: string[]
}

export interface TaskUpdatedPayload {
  /** 更新的字段 */
  subject?: string
  description?: string
}

export interface TaskStatusChangedPayload {
  oldStatus: TaskStatus | null
  newStatus: TaskStatus
}

export interface TaskDependencyAddedPayload {
  dependsOn: string
}

export interface TaskArtifactAddedPayload {
  artifact: string
}

export interface TaskSessionLinkedPayload {
  /** 关联的子会话 ID（delegation ID 或 SDK session ID） */
  sessionId: string
}

// ===== Project 元数据 =====

/** Project 会话类型标记 */
export type SessionType = 'standard' | 'project'

/** Project 状态 */
export type ProjectStatus = 'active' | 'completed' | 'archived'

/** Project 元数据（存储在 AgentSessionMeta 的扩展字段中） */
export interface ProjectMeta {
  /** 项目状态 */
  projectStatus: ProjectStatus
  /** 主会话 ID（用户直接交互的权威入口会话） */
  mainSessionId: string
  /** Graph 状态文件路径（相对于 project JSONL 目录） */
  graphJsonlPath: string
  /** Task 总数 */
  totalTasks: number
  /** 已完成 Task 数 */
  completedTasks: number
  /** 项目创建时间 */
  createdAt: number
  /** 项目最后活跃时间 */
  lastActiveAt: number
}

// ===== DAG 布局 =====

/** 拓扑层级中的一层 */
export interface LayoutLevel {
  /** 层级编号（0 = 根节点） */
  level: number
  /** 该层中的节点 */
  nodes: TaskNode[]
}

/** DAG 布局结果 */
export interface LayoutResult {
  /** 按层级分组的节点 */
  levels: LayoutLevel[]
  /** 总层级数 */
  totalLevels: number
  /** 最大层宽（节点数最多的层） */
  maxNodesInLevel: number
}

// ===== deriveGraph 输入 =====

/** aggregateTaskItems 产出的 TaskItem 的最小投影 */
export interface TaskItemInput {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  description?: string
}

// ===== Graph 查询接口 =====

/** Graph 摘要（用于项目概览和 preamble 注入） */
export interface GraphSummary {
  /** Task 总数 */
  totalTasks: number
  /** 各状态计数 */
  statusCounts: Record<TaskStatus, number>
  /** 下一个待执行的 pending Task 列表（所有依赖已满足） */
  nextPending: TaskNode[]
  /** 最近完成的 Task 摘要 */
  recentCompleted: RecentCompletedTask[]
}

/** 最近完成的 Task 摘要 */
export interface RecentCompletedTask {
  id: string
  subject: string
  artifact: string[]
}

// ===== SDK 事件提取输入 =====

/** 从 SDK 事件提取 Graph 更新的输入 */
export interface ExtractGraphInput {
  /** 事件时间戳 */
  timestamp: number
  /** SDK 工具名称（TaskCreate / TaskUpdate 等） */
  toolName: string
  /** 工具输入参数 */
  toolInput: Record<string, unknown>
  /** 已存在的 Task ID（TaskUpdate 时使用） */
  existingTaskId?: string
}
