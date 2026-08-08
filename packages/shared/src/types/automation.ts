/**
 * Automation（定时任务）相关类型
 *
 * 用户用自然语言描述一个任务，调度器按设定间隔在后台自动新建子会话执行。
 * 每次执行都新建独立子会话（不污染来源会话，规避 orchestrator 同会话并发守卫）。
 */

/** 单次自动运行的记录 */
export interface AutomationRun {
  /** 本次触发的时间戳 */
  runAt: number
  /** 本轮新建的子会话 ID（可点进去查看执行详情） */
  sessionId: string
  /** 运行结果 */
  status: 'success' | 'error' | 'skipped'
  /** 耗时（毫秒） */
  durationMs?: number
  /** 失败原因（status === 'error' 时） */
  error?: string
  /** 跳过原因（status === 'skipped' 时，如来源会话忙） */
  skipReason?: string
}

/** 调度模式 */
export type AutomationScheduleType = 'interval' | 'daily' | 'weekly' | 'monthly' | 'once'

/**
 * 定时任务的权限模式（无人值守运行场景）
 * - bypassPermissions：完全自动，所有工具调用自动允许
 * 不含 plan（计划模式只规划不执行，对定时任务无意义）
 */
export type AutomationPermissionMode = 'bypassPermissions'

/** 定时任务默认权限模式（向后兼容：旧任务无此字段时按此值运行） */
export const AUTOMATION_DEFAULT_PERMISSION_MODE: AutomationPermissionMode = 'bypassPermissions'

/**
 * 定时任务的会话模式
 * - daily：同一自然日内的触发写入同一个子会话，跨日时自动新建（默认，兼顾上下文连续性与成本控制）
 * - reuse：始终复用同一个子会话（保留长期上下文，会话越长 token 成本越高，由用户自行承担）
 */
export type AutomationSessionMode = 'daily' | 'reuse'

/** 定时任务默认会话模式 */
export const AUTOMATION_DEFAULT_SESSION_MODE: AutomationSessionMode = 'daily'

/** 定时任务通知触发条件 */
export type AutomationNotificationTrigger = 'always' | 'success' | 'error'

/** 飞书通知目标 */
export interface AutomationFeishuNotificationTarget {
  type: 'feishu'
  enabled: boolean
  /** 通知触发条件：默认 always */
  trigger: AutomationNotificationTrigger
  /** 负责发送通知的飞书 Bot ID */
  botId: string
  /** 飞书 chat_id（来自已有绑定） */
  chatId: string
}

/** 定时任务通知目标（钉钉/微信后续扩展） */
export type AutomationNotificationTarget = AutomationFeishuNotificationTarget

/** 定时任务定义 */
export interface Automation {
  id: string
  /** 任务名（默认从来源消息生成，可编辑） */
  name: string
  /** 自然语言任务描述（每次自动重跑发送的内容） */
  prompt: string
  /** 是否启用调度 */
  active: boolean
  /** 调度模式：interval=固定间隔；daily=每天定点；weekly=每周某天定点；monthly=每月某天定点；once=指定时刻只运行一次 */
  scheduleType: AutomationScheduleType
  /** 运行间隔（分钟），scheduleType==='interval' 时使用 */
  intervalMinutes: number
  /** 触发时刻 "HH:MM"，scheduleType==='daily'|'weekly'|'monthly' 时使用。支持多个时间点。 */
  timeOfDay?: string[]
  /** 星期几（0=周日 … 6=周六），scheduleType==='weekly' 时使用。支持多选。 */
  dayOfWeek?: number[]
  /** 每月几号（1-31），scheduleType==='monthly' 时使用。支持多个日期。 */
  dayOfMonth?: number[]
  /** 一次性任务的绝对触发时间戳，scheduleType==='once' 时使用 */
  scheduledAt?: number
  /**
   * 最大运行次数上限：实际执行次数（成功 + 失败，不含 skipped）达到后自动停用。
   * undefined = 不限次（默认，向后兼容旧任务）。
   * 与 scheduleType 正交——任意循环模式都可叠加；once 模式语义上等价于 maxRuns=1。
   */
  maxRuns?: number
  /** 本任务运行时使用的 Agent runtime；历史任务缺省为 claude */
  agentRuntime?: import('./agent-provider').AgentRuntime
  /** AI 渠道 ID */
  channelId: string
  /** 模型 ID（可选，继承来源会话或渠道默认） */
  modelId?: string
  /** 工作区 ID（可选，决定子会话 cwd） */
  workspaceId?: string
  /** 权限模式（无人值守运行时的工具审批策略，默认 bypassPermissions） */
  permissionMode?: AutomationPermissionMode
  /** 会话模式：daily=同一自然日内复用子会话，跨日新建（默认）；reuse=始终复用同一个子会话 */
  sessionMode?: AutomationSessionMode
  /** 运行完成后的外部通知目标 */
  notificationTargets?: AutomationNotificationTarget[]
  /** 创建来源会话 ID（作为模板，运行时不复用而是新建子会话） */
  sourceSessionId?: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 下次应触发的绝对时间戳（调度核心，避免长 interval 漂移） */
  nextRunAt: number
  /** 最近一次运行创建的会话 ID（每次运行都会新建会话，此字段仅用于跳转和排查） */
  lastSessionId?: string
  /** 上次运行时间 */
  lastRunAt?: number
  /** 连续失败次数（用于退避/自动暂停） */
  consecutiveFailures?: number
  /** 已实际执行次数（成功 + 失败，不含 skipped），用于与 maxRuns 比较 */
  runCount?: number
  /**
   * 因跑满 maxRuns 或 once 完成而自动停用的时间戳。
   * 区别于用户手动暂停（active=false 但无 completedAt）和连续失败暂停，
   * 让 UI 能把「已完成」与「已暂停」区分展示。重新启用时会被清空。
   */
  completedAt?: number
  /** 最近运行历史（截断保留最新 AUTOMATION_MAX_HISTORY 条） */
  runHistory: AutomationRun[]
}

/** 运行历史最大保留条数（防止 json 无限膨胀） */
export const AUTOMATION_MAX_HISTORY = 20

/** 连续失败达到此次数自动暂停任务 */
export const AUTOMATION_MAX_CONSECUTIVE_FAILURES = 5

/** HH:MM 24 小时制格式校验（与 Agent 工具路径的 TIME_OF_DAY_PATTERN 保持一致） */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 归一化 timeOfDay：接受 string | string[] | undefined，返回排序去重的 string[]
 * 旧数据单值 "09:00" 自动转为 ["09:00"]；非法格式（如 "25:99"）直接丢弃，
 * 避免 JS Date setHours 静默溢出到次日产生与用户预期不符的触发时间。
 */
export function normalizeTimeOfDay(input?: string | string[]): string[] {
  if (!input) return []
  const arr = Array.isArray(input) ? input : [input]
  return [...new Set(arr)].filter((t) => typeof t === 'string' && TIME_OF_DAY_PATTERN.test(t)).sort()
}

/**
 * 归一化 dayOfWeek：接受 number | number[] | undefined，返回排序去重的 number[]
 * 旧数据单值 1 自动转为 [1]
 */
export function normalizeDayOfWeek(input?: number | number[]): number[] {
  if (input === undefined || input === null) return []
  const arr = Array.isArray(input) ? input : [input]
  return [...new Set(arr)].filter((d) => Number.isFinite(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
}

/**
 * 归一化 dayOfMonth：接受 number | number[] | undefined，返回排序去重的 number[]
 * 旧数据单值 1 自动转为 [1]
 */
export function normalizeDayOfMonth(input?: number | number[]): number[] {
  if (input === undefined || input === null) return []
  const arr = Array.isArray(input) ? input : [input]
  return [...new Set(arr)].filter((d) => Number.isFinite(d) && d >= 1 && d <= 31).sort((a, b) => a - b)
}

/** timeOfDay 默认值 */
export const DEFAULT_TIME_OF_DAY: string[] = ['09:00']
/** dayOfWeek 默认值 */
export const DEFAULT_DAY_OF_WEEK: number[] = [1]
/** dayOfMonth 默认值 */
export const DEFAULT_DAY_OF_MONTH: number[] = [1]

/** 创建定时任务的输入 */
export interface CreateAutomationInput {
  name: string
  prompt: string
  scheduleType: AutomationScheduleType
  intervalMinutes: number
  /** 触发时刻（可多个）；兼容旧调用传单值 string */
  timeOfDay?: string | string[]
  /** 星期几（可多选）；兼容旧调用传单值 number */
  dayOfWeek?: number | number[]
  /** 每月几号（可多选）；兼容旧调用传单值 number */
  dayOfMonth?: number | number[]
  /** 一次性任务的绝对触发时间戳，scheduleType==='once' 时必填 */
  scheduledAt?: number
  /** 最大运行次数上限（实际执行次数），达到后自动停用；不传 = 不限次 */
  maxRuns?: number
  /** 本任务运行时使用的 Agent runtime；不传则为 claude */
  agentRuntime?: import('./agent-provider').AgentRuntime
  channelId: string
  modelId?: string
  workspaceId?: string
  permissionMode?: AutomationPermissionMode
  sessionMode?: AutomationSessionMode
  notificationTargets?: AutomationNotificationTarget[]
  sourceSessionId?: string
  /** 创建后是否立即启用（默认 true） */
  active?: boolean
}

/** 更新定时任务的输入（部分字段） */
export interface UpdateAutomationInput {
  id: string
  name?: string
  prompt?: string
  scheduleType?: AutomationScheduleType
  intervalMinutes?: number
  /** 触发时刻（可多个）；兼容旧调用传单值 string */
  timeOfDay?: string | string[]
  /** 星期几（可多选）；兼容旧调用传单值 number */
  dayOfWeek?: number | number[]
  /** 每月几号（可多选）；兼容旧调用传单值 number */
  dayOfMonth?: number | number[]
  /** 一次性任务的绝对触发时间戳，scheduleType==='once' 时使用 */
  scheduledAt?: number
  /** 最大运行次数上限（实际执行次数）；传 0 或负数等价于不限次。改动会重置已执行次数计数 */
  maxRuns?: number
  /** 本任务运行时使用的 Agent runtime */
  agentRuntime?: import('./agent-provider').AgentRuntime
  channelId?: string
  modelId?: string
  /** 工作区（用户可在创建后调整子会话归属的工作区） */
  workspaceId?: string
  permissionMode?: AutomationPermissionMode
  sessionMode?: AutomationSessionMode
  notificationTargets?: AutomationNotificationTarget[]
  active?: boolean
}

/** Automation 相关 IPC 通道常量 */
export const AUTOMATION_IPC_CHANNELS = {
  /** 获取全部定时任务 */
  LIST: 'automation:list',
  /** 创建定时任务 */
  CREATE: 'automation:create',
  /** 更新定时任务 */
  UPDATE: 'automation:update',
  /** 删除定时任务 */
  DELETE: 'automation:delete',
  /** 切换启用/暂停 */
  TOGGLE: 'automation:toggle',
  /** 立即运行一次（不影响调度计时） */
  RUN_NOW: 'automation:run-now',
  /** 任务列表变更事件（main → renderer，运行完成/状态变化时推送） */
  CHANGED: 'automation:changed',
} as const
