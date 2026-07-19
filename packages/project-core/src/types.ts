/**
 * @profer/project-core — Agent 项目编排核心类型
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
  /**
   * 回溯抽取的放弃原因（枯死支线：为什么这个方向被放弃）。
   * 与 forkReason 语义分离：forkReason=分叉血缘，abandonReason=放弃理由。
   * 由回溯分析 pass 通读会话 JSONL 后写入，非来自 SDK TaskCreate/Update。
   */
  abandonReason?: string
  /** 放弃判定置信度 0-1 */
  abandonConfidence?: number
  /** 支撑放弃判定的会话轮次索引 */
  abandonEvidence?: number[]
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
  | 'task_abandon_annotated'
  | 'task_deleted'

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
  | (GraphEventBase & { type: 'task_abandon_annotated'; payload: TaskAbandonAnnotatedPayload })
  | (GraphEventBase & { type: 'task_deleted'; payload: TaskDeletedPayload })

/** Graph 事件载荷联合类型 */
export type GraphEventPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskStatusChangedPayload
  | TaskDependencyAddedPayload
  | TaskArtifactAddedPayload
  | TaskSessionLinkedPayload
  | TaskAbandonAnnotatedPayload
  | TaskDeletedPayload

export interface TaskCreatedPayload {
  subject: string
  description: string
  dependsOn: string[]
  /** 创建时的父任务；用于持久化自动或显式父子分叉关系。 */
  forkFrom?: string
}

export interface TaskUpdatedPayload {
  /** 更新的字段 */
  subject?: string
  description?: string
  /**
   * 完整依赖列表。存在时（包括空数组）替换旧依赖，而不是追加。
   * 让结构化 MCP 工具能够表达“清空所有前置任务”。
   */
  dependsOn?: string[]
  /** 分叉来源任务；存在时替换该任务原有父子关系。 */
  forkFrom?: string
}

export interface TaskStatusChangedPayload {
  oldStatus?: TaskStatus | null
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
  /** 如果通过协作委派执行，子 Agent 会话的实际 session ID（可直接用于导航跳转） */
  childSessionId?: string
}

export interface TaskAbandonAnnotatedPayload {
  /** 放弃原因（自然语言） */
  reason: string
  /** 放弃判定置信度 0-1（Agent 显式标注恒为 1） */
  confidence: number
  /** 支撑放弃判定的会话轮次索引（Agent 显式标注为空） */
  evidenceTurns: number[]
  /** 抽取来源：'agent'=Agent 干活时用 @abandon 显式标注；'retrospective'=AI 回溯 pass（已停用，保留兼容） */
  source: 'retrospective' | 'agent'
}

export interface TaskDeletedPayload {
  /**
   * 删除来源。'user'=用户在图上显式删除；'agent'=Agent 调 TaskUpdate(status='deleted')。
   * 与「放弃(abandon 枯枝，保留留痕)」「取消(cancelled，保留灰化)」语义区分：删除是真从图上移除节点。
   */
  source?: 'user' | 'agent'
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

// ===== DAG 布局（层级式，已保留向后兼容） =====

/** 拓扑层级中的一层 */
export interface LayoutLevel {
  /** 层级编号（0 = 根节点） */
  level: number
  /** 该层中的节点 */
  nodes: TaskNode[]
}

/** DAG 布局结果（层级式） */
export interface LayoutResult {
  /** 按层级分组的节点 */
  levels: LayoutLevel[]
  /** 总层级数 */
  totalLevels: number
  /** 最大层宽（节点数最多的层） */
  maxNodesInLevel: number
}

// ===== 力导向布局（知识图谱风格） =====

/** 力导向布局选项 */
export interface ForceLayoutOptions {
  /** 最大迭代次数（默认 300） */
  iterations?: number
  /** 库仑斥力强度（默认 5000） */
  repulsionStrength?: number
  /** 弹簧引力强度（默认 0.01） */
  attractionStrength?: number
  /** 弹簧理想长度（默认 200） */
  edgeLength?: number
  /** DAG 方向力强度（默认 0.1），正值推动节点从左向右 */
  dagDirectionStrength?: number
  /** 向心力强度（默认 0.05） */
  centerGravity?: number
}

/** 单个节点的布局位置 */
export interface NodePosition {
  id: string
  x: number
  y: number
}

/** 力导向布局结果 */
export interface ForceLayoutResult {
  /** 节点 ID → 位置映射 */
  positions: Map<string, { x: number; y: number }>
  /** 画布总宽度 */
  canvasWidth: number
  /** 画布总高度 */
  canvasHeight: number
  /** 实际执行的迭代次数 */
  iterations: number
}

/** 分叉边渲染布局数据 */
export interface ForkEdgeLayout {
  /** 分叉源 Task ID */
  from: string
  /** 新 Task ID */
  to: string
  /** 原因 */
  reason?: string
  /** 起点坐标 */
  x1: number
  y1: number
  /** 终点坐标 */
  x2: number
  y2: number
  /** SVG 路径 d 属性 */
  d: string
  /** 颜色 */
  lineColor: string
}

// ===== deriveGraph 输入 =====

/** aggregateTaskItems 产出的 TaskItem 的最小投影 */
export interface TaskItemInput {
  id: string
  subject: string
  status: TaskStatus | 'deleted'
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
  /** 最近被取消的 Task 摘要（用于打断后提醒 AI 不要恢复） */
  recentCancelled: RecentCompletedTask[]
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

// ===== 回溯放弃抽取结果 =====

/** 挂不到任务节点、降级为文字注记的放弃（不进图） */
export interface UnmappedAbandonment {
  /** 被放弃方向的简短名称 */
  direction: string
  /** 放弃原因 */
  reason: string
  /** 最能体现放弃的对话原话摘录 */
  reasonVerbatim: string
  /** 支撑证据的会话轮次索引 */
  evidenceTurns: number[]
  /** 放弃后转向了什么（无则 null） */
  switchedTo: string | null
  /** 放弃判定置信度 0-1 */
  confidence: number
}

/** 回溯放弃抽取的结果（IPC 返回给渲染层） */
export interface RetrospectiveResult {
  /** 刷新后的完整图（渲染层直接 setPersistedGraph） */
  graph: TaskGraph
  /** 本轮新增写入图的放弃事件数 */
  newAbandonments: number
  /** 挂不到节点、降级为文字注记的放弃 */
  unmappedNotes: UnmappedAbandonment[]
  /** 本次分析的轮次范围 */
  analyzedRange: { start: number; end: number }
  /** 更新后的水位（已分析到的最新轮次） */
  lastAnalyzedTurn: number
  /** 若本次未执行抽取，说明原因（no-new-turns / llm-failed / parse-failed） */
  skipped?: string
}
