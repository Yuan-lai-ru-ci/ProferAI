/**
 * 定时任务（Automation）与推荐（Recommendation）的 IPC 注册。
 *
 * 从 ipc.ts 的 registerIpcHandlers 中整体搬出，注册顺序与原先一致：
 * 由 registerIpcHandlers 在原位置调用 registerAutomationIpc()。
 * 入参校验全部为本模块内的局部函数，不对外导出。
 */
import { ipcMain } from 'electron'
import {
  AUTOMATION_IPC_CHANNELS,
  RECOMMENDATION_IPC_CHANNELS,
  type Automation,
  type CreateAutomationInput,
  type UpdateAutomationInput,
  type AgentSessionMeta,
} from '@profer/shared'
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  updateAutomation,
} from './automation-manager'
import { runAutomationNow, broadcastChanged as broadcastAutomationsChanged } from './automation-scheduler'
import { applyRecommendationFeedback, listRecommendations } from './recommendation-manager'
import { refreshAutomationRecommendations } from './recommendation-engine'
import { getAgentSessionMeta, listAgentSessions } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { resolvePresetId, getDefaultPresetId } from './agent-preset-manager'
import { validateBoundAutomationChannel, validateBoundAutomationSession, withTrustedAutomationPromptAuthor } from './automation-dispatch'

export function registerAutomationIpc(): void {

  // 渲染进程可能被注入内容污染（XSS via markdown / MCP tool output），主进程必须自己校验入参，
  // 否则 NaN / -Infinity / 越界值会污染 ~/.profer/automations.json，无法回滚。
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isNonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
  const isFiniteInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
  const validScheduleType = (v: unknown): v is 'interval' | 'daily' | 'weekly' | 'monthly' =>
    v === 'interval' || v === 'daily' || v === 'weekly' || v === 'monthly'
  const validPermissionMode = (v: unknown): v is 'auto' | 'bypassPermissions' =>
    v === 'auto' || v === 'bypassPermissions'
  const validAutomationNotificationTrigger = (v: unknown): v is 'always' | 'success' | 'error' =>
    v === 'always' || v === 'success' || v === 'error'
  const validTimeOfDay = (v: unknown): boolean => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

  const validateAutomationNotificationTargets = (targets: unknown): void => {
    if (targets === undefined) return
    if (!Array.isArray(targets)) throw new Error('notificationTargets 必须是数组')
    if (targets.length > 5) throw new Error('notificationTargets 最多 5 个')

    for (const target of targets) {
      if (!target || typeof target !== 'object') throw new Error('notificationTargets 包含非法目标')
      const t = target as Record<string, unknown>
      if (t.type !== 'feishu') throw new Error(`不支持的通知目标: ${String(t.type)}`)
      if (typeof t.enabled !== 'boolean') throw new Error('notificationTargets.enabled 必须是 boolean')
      if (!validAutomationNotificationTrigger(t.trigger)) {
        throw new Error(`非法的 notificationTargets.trigger: ${String(t.trigger)}`)
      }
      if (!isNonEmptyString(t.botId)) throw new Error('notificationTargets.botId 必填')
      if (!isNonEmptyString(t.chatId)) throw new Error('notificationTargets.chatId 必填')
    }
  }

  /** 校验 timeOfDay：单个或数组，每个必须是 HH:MM。空数组合法（非 daily/weekly/monthly 不依赖该字段）。 */
  const validTimeOfDayArr = (v: unknown): boolean => {
    if (typeof v === 'string') return validTimeOfDay(v)
    if (Array.isArray(v)) return v.length <= 10 && v.every((t) => typeof t === 'string' && validTimeOfDay(t))
    return false
  }
  /** 校验 dayOfWeek：单个或数组，每个必须是 0-6。空数组合法（非 weekly 不依赖该字段）。 */
  const validDayOfWeekArr = (v: unknown): boolean => {
    if (typeof v === 'number') return isFiniteInt(v) && v >= 0 && v <= 6
    if (Array.isArray(v)) return v.length <= 7 && v.every((d) => typeof d === 'number' && isFiniteInt(d) && d >= 0 && d <= 6)
    return false
  }
  /** 校验 dayOfMonth：单个或数组，每个必须是 1-31。空数组合法（非 monthly 不依赖该字段）。 */
  const validDayOfMonthArr = (v: unknown): boolean => {
    if (typeof v === 'number') return isFiniteInt(v) && v >= 1 && v <= 31
    if (Array.isArray(v)) return v.length <= 31 && v.every((d) => typeof d === 'number' && isFiniteInt(d) && d >= 1 && d <= 31)
    return false
  }

  const validateAutomationFields = (i: Partial<CreateAutomationInput | UpdateAutomationInput>): void => {
    if (i.presetId !== undefined && (typeof i.presetId !== 'string' || i.presetId.length > 200)) {
      throw new Error(`非法的 presetId: ${String(i.presetId)}（应为预设 ID 字符串；空字符串恢复默认）`)
    }
    if (i.scheduleType !== undefined && !validScheduleType(i.scheduleType)) {
      throw new Error(`非法的 scheduleType: ${String(i.scheduleType)}`)
    }
    if (i.intervalMinutes !== undefined && (!isFiniteInt(i.intervalMinutes) || i.intervalMinutes < 1)) {
      throw new Error(`非法的 intervalMinutes: ${String(i.intervalMinutes)}`)
    }
    if (i.timeOfDay !== undefined && !validTimeOfDayArr(i.timeOfDay)) {
      throw new Error(`非法的 timeOfDay: ${JSON.stringify(i.timeOfDay)}（需为 HH:MM 或最多 10 个的数组）`)
    }
    if (i.dayOfWeek !== undefined && !validDayOfWeekArr(i.dayOfWeek)) {
      throw new Error(`非法的 dayOfWeek: ${JSON.stringify(i.dayOfWeek)}（需为 0-6 整数或数组）`)
    }
    if (i.dayOfMonth !== undefined && !validDayOfMonthArr(i.dayOfMonth)) {
      throw new Error(`非法的 dayOfMonth: ${JSON.stringify(i.dayOfMonth)}（需为 1-31 整数或数组）`)
    }
    if (i.permissionMode !== undefined && !validPermissionMode(i.permissionMode)) {
      throw new Error(`非法的 permissionMode: ${String(i.permissionMode)}`)
    }
    if (i.sessionMode !== undefined && i.sessionMode !== 'daily' && i.sessionMode !== 'reuse') {
      throw new Error(`非法的 sessionMode: ${String(i.sessionMode)}`)
    }
    if (i.boundSessionId !== undefined && (typeof i.boundSessionId !== 'string' || i.boundSessionId.length > 200)) {
      throw new Error('boundSessionId 必须是有效的会话 ID 字符串')
    }
    validateAutomationNotificationTargets(i.notificationTargets)
  }

  const validateBoundSession = (input: Partial<CreateAutomationInput | UpdateAutomationInput>, existing?: Automation): void => {
    const requested = input.boundSessionId !== undefined
      ? (input.boundSessionId || undefined)
      : (input as CreateAutomationInput).boundSessionId ?? existing?.boundSessionId
    if (!requested) return
    const workspaceId = input.workspaceId !== undefined ? (input.workspaceId || undefined) : existing?.workspaceId
    const channelId = input.channelId ?? existing?.channelId
    if (!workspaceId || !channelId) throw new Error('绑定目标会话前必须配置工作区与渠道')
    const automation = {
      workspaceId,
      channelId,
      agentRuntime: input.agentRuntime ?? existing?.agentRuntime ?? 'claude',
      presetId: input.presetId !== undefined ? (input.presetId || undefined) : existing?.presetId,
    }
    const session: AgentSessionMeta | undefined = getAgentSessionMeta(requested)
    if (!session) throw new Error('目标会话绑定无效：绑定会话不存在或不可访问')
    const workspaceSlug = getAgentWorkspace(workspaceId)?.slug
    const expectedPresetId = automation.presetId
      ? resolvePresetId(workspaceSlug, automation.presetId)
      : getDefaultPresetId(workspaceSlug)
    const result = validateBoundAutomationSession(automation, session, expectedPresetId)
    if (!result.valid) throw new Error(`目标会话绑定无效：${result.reason}`)
    const channel = getChannelById(channelId)
    const availability = validateBoundAutomationChannel({ ...automation, modelId: input.modelId ?? existing?.modelId }, session, channel)
    if (!availability.valid) throw new Error(`目标会话绑定无效：${availability.reason}`)
  }

  ipcMain.handle(RECOMMENDATION_IPC_CHANNELS.LIST, async () => listRecommendations())
  ipcMain.handle(RECOMMENDATION_IPC_CHANNELS.REFRESH, async () => {
    refreshAutomationRecommendations(listAutomations())
    return listRecommendations()
  })
  ipcMain.handle(RECOMMENDATION_IPC_CHANNELS.FEEDBACK, async (_, input) => {
    if (!input || typeof input.id !== 'string' || !['accepted', 'dismissed', 'snoozed'].includes(input.status)) throw new Error('无效的推荐反馈')
    const result = applyRecommendationFeedback(input)
    if (!result) throw new Error('推荐不存在')
    return result
  })

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.LIST,
    async (): Promise<Automation[]> => listAutomations()
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.CREATE,
    async (_, input: CreateAutomationInput): Promise<Automation> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.name)) throw new Error('name 必填')
      if (!isNonEmptyString(input.prompt)) throw new Error('prompt 必填')
      // channelId / workspaceId 允许为空（草稿态），但此时任务不能被启用
      validateAutomationFields(input)
      validateBoundSession(input)
      if (input.scheduleType === 'interval' && !isFiniteInt(input.intervalMinutes)) throw new Error('scheduleType=interval 时 intervalMinutes 必填')
      if ((input.scheduleType === 'daily' || input.scheduleType === 'weekly' || input.scheduleType === 'monthly') && !validTimeOfDayArr(input.timeOfDay)) throw new Error('scheduleType=daily/weekly/monthly 时 timeOfDay 必填（支持数组）')
      if (input.scheduleType === 'weekly' && !validDayOfWeekArr(input.dayOfWeek)) throw new Error('scheduleType=weekly 时 dayOfWeek 必填（支持数组）')
      if (input.scheduleType === 'monthly' && !validDayOfMonthArr(input.dayOfMonth)) throw new Error('scheduleType=monthly 时 dayOfMonth 必填（支持数组）')
      const a = createAutomation(withTrustedAutomationPromptAuthor(input, { type: 'user' }))
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.UPDATE,
    async (_, input: UpdateAutomationInput): Promise<Automation | undefined> => {
      if (!input || typeof input !== 'object') throw new Error('input 必须是对象')
      if (!isNonEmptyString(input.id)) throw new Error('id 必填')
      if (input.name !== undefined && !isNonBlankString(input.name)) throw new Error('name 不能为空')
      if (input.prompt !== undefined && !isNonBlankString(input.prompt)) throw new Error('prompt 不能为空')
      validateAutomationFields(input)
      const existing = listAutomations().find((automation) => automation.id === input.id)
      const normalizeOptional = (value: string | undefined): string | undefined => value?.trim() || undefined
      const routeChanged = !!existing && (
        (input.boundSessionId !== undefined && normalizeOptional(input.boundSessionId) !== existing.boundSessionId)
        || (input.workspaceId !== undefined && normalizeOptional(input.workspaceId) !== existing.workspaceId)
        || (input.channelId !== undefined && input.channelId !== existing.channelId)
        || (input.agentRuntime !== undefined && input.agentRuntime !== existing.agentRuntime)
        || (input.presetId !== undefined && normalizeOptional(input.presetId) !== existing.presetId)
        || (input.modelId !== undefined && input.modelId !== existing.modelId)
      )
      if (routeChanged) validateBoundSession(input, existing)
      const a = updateAutomation(withTrustedAutomationPromptAuthor(input, { type: 'user' }))
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.DELETE,
    async (_, id: string): Promise<boolean> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      const ok = deleteAutomation(id)
      broadcastAutomationsChanged()
      return ok
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.TOGGLE,
    async (_, id: string, active: boolean): Promise<Automation | undefined> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      if (typeof active !== 'boolean') throw new Error('active 必须是 boolean')
      const a = updateAutomation({ id, active })
      broadcastAutomationsChanged()
      return a
    }
  )

  ipcMain.handle(
    AUTOMATION_IPC_CHANNELS.RUN_NOW,
    async (_, id: string): Promise<void> => {
      if (!isNonEmptyString(id)) throw new Error('id 必填')
      await runAutomationNow(id)
    }
  )
}
