import type {
  Automation,
  AutomationNotificationTarget,
  AutomationScheduleType,
  AutomationPermissionMode,
  AutomationSessionMode,
  AgentRuntime,
} from '@profer/shared'
import { AUTOMATION_DEFAULT_PERMISSION_MODE, AUTOMATION_DEFAULT_SESSION_MODE } from '@profer/shared'

/** 自动任务编辑草稿；无 id 表示创建模式。 */
export interface AutomationDraft {
  id?: string
  name: string
  prompt: string
  scheduleType: AutomationScheduleType
  intervalMinutes: number
  timeOfDay: string[]
  dayOfWeek: number[]
  dayOfMonth: number[]
  channelId: string
  modelId?: string
  agentRuntime: AgentRuntime
  workspaceId?: string
  presetId?: string
  permissionMode: AutomationPermissionMode
  sessionMode: AutomationSessionMode
  notificationTargets?: AutomationNotificationTarget[]
  sourceSessionId?: string
  active: boolean
}

/** 创建一个空白草稿（用于「+ 新建」）。 */
export function createEmptyDraft(): AutomationDraft {
  return {
    name: '',
    prompt: '',
    scheduleType: 'interval',
    intervalMinutes: 10,
    timeOfDay: ['09:00'],
    dayOfWeek: [1],
    dayOfMonth: [1],
    channelId: '',
    agentRuntime: 'claude',
    permissionMode: AUTOMATION_DEFAULT_PERMISSION_MODE,
    sessionMode: AUTOMATION_DEFAULT_SESSION_MODE,
    active: true,
  }
}

/** 把持久化任务映射成表单草稿，兼容历史单值调度字段。 */
export function automationToDraft(a: Automation): AutomationDraft {
  return {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    scheduleType: a.scheduleType,
    intervalMinutes: a.intervalMinutes,
    timeOfDay: Array.isArray(a.timeOfDay) ? a.timeOfDay : (a.timeOfDay ? [a.timeOfDay] : ['09:00']),
    dayOfWeek: Array.isArray(a.dayOfWeek) ? a.dayOfWeek : (a.dayOfWeek !== undefined ? [a.dayOfWeek] : [1]),
    dayOfMonth: Array.isArray(a.dayOfMonth) ? a.dayOfMonth : (a.dayOfMonth !== undefined ? [a.dayOfMonth] : [1]),
    channelId: a.channelId,
    modelId: a.modelId,
    agentRuntime: a.agentRuntime ?? 'claude',
    workspaceId: a.workspaceId,
    presetId: a.presetId,
    permissionMode: a.permissionMode ?? AUTOMATION_DEFAULT_PERMISSION_MODE,
    sessionMode: a.sessionMode ?? AUTOMATION_DEFAULT_SESSION_MODE,
    notificationTargets: a.notificationTargets,
    sourceSessionId: a.sourceSessionId,
    active: a.active,
  }
}
