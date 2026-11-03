import { BrowserWindow, ipcMain } from 'electron'
import {
  PLANNING_IPC_CHANNELS,
  PLANNING_CONFLICT_ERROR,
  type ActivePlanningReminder,
  type CalendarEvent,
  type CalendarEventListQuery,
  type CreateCalendarEventInput,
  type CreatePlanningGroupInput,
  type PlanningGroup,
  type PlanningGroupScope,
  type PlanningReminder,
  type PlanningTag,
  type StartTodoAgentInput,
  type StartTodoAgentResult,
  type SnoozePlanningReminderInput,
  type Todo,
  type TodoListQuery,
  type CreateTodoInput,
  type UpdateCalendarEventInput,
  type UpdatePlanningGroupInput,
  type UpdateTodoInput,
  type CreatePlanningTagInput,
  type UpdatePlanningTagInput,
} from '@profer/shared'
import {
  listPlanningGroups,
  createPlanningGroup,
  updatePlanningGroup,
  deletePlanningGroup,
  listPlanningTags,
  createPlanningTag,
  updatePlanningTag,
  deletePlanningTag,
  listActivePlanningReminders,
  acknowledgePlanningReminder,
  snoozePlanningReminder,
  listTodos,
  createTodo,
  getTodo,
  updateTodo,
  deleteTodo,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './planning-manager'
import { broadcastPlanningChanged } from './planning-events'
import { getAgentWorkspace } from './agent-workspace-manager'
import { createAgentSession } from './agent-session-manager'
import { getSettings } from './settings-service'
import { feishuBridgeManager } from './feishu-bridge-manager'

const isPlanningTitle = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 500
const isPlanningTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const isTodoPriority = (value: unknown): value is 'low' | 'medium' | 'high' =>
  value === 'low' || value === 'medium' || value === 'high'
const isTodoStatus = (value: unknown): value is 'open' | 'completed' =>
  value === 'open' || value === 'completed'
const isPlanningShortName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 100
const isPlanningGroupScope = (value: unknown): value is PlanningGroupScope => value === 'todo' || value === 'calendar'
const isOptionalColor = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string'

function parseTodoListQuery(input: unknown): TodoListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object') throw new Error('Todo 查询参数非法')
  const query = input as TodoListQuery
  if (query.status !== undefined && !isTodoStatus(query.status)) throw new Error('Todo status 非法')
  if (query.dueBefore !== undefined && !isPlanningTimestamp(query.dueBefore)) throw new Error('Todo dueBefore 非法')
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('Todo limit 非法')
  return query
}

function parseCalendarEventListQuery(input: unknown): CalendarEventListQuery {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object') throw new Error('日程查询参数非法')
  const query = input as CalendarEventListQuery
  if (query.from !== undefined && !isPlanningTimestamp(query.from)) throw new Error('日程 from 非法')
  if (query.to !== undefined && !isPlanningTimestamp(query.to)) throw new Error('日程 to 非法')
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) throw new Error('日程范围非法')
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('日程 limit 非法')
  return query
}

export function registerPlanningIpc(): void {
  ipcMain.handle(PLANNING_IPC_CHANNELS.OPEN_WINDOW, async (): Promise<void> => {
    const { showPlanningWindow } = await import('./planning-window')
    showPlanningWindow()
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TODOS, async (_, input?: unknown): Promise<Todo[]> => {
    return listTodos(parseTodoListQuery(input))
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_TODO, async (_, input: CreateTodoInput): Promise<Todo> => {
    if (!input || !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.dueAt !== undefined && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId.trim())) throw new Error('Todo sessionId 非法')
    if (input.workspaceId && !getAgentWorkspace(input.workspaceId)) throw new Error('所选项目已不可用，请重新选择')
    const todo = createTodo(input)
    broadcastPlanningChanged(['todos', 'reminders'])
    return todo
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.START_TODO_AGENT, (event, input: StartTodoAgentInput): StartTodoAgentResult => {
    if (!input || typeof input.todoId !== 'string' || !input.todoId.trim()) throw new Error('Todo id 必填')
    if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('项目 id 必填')
    if (!isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    if (typeof input.channelId !== 'string' || !input.channelId.trim()) throw new Error('Agent 渠道必填')
    if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !input.modelId.trim())) throw new Error('Agent 模型非法')
    if (!getAgentWorkspace(input.workspaceId)) throw new Error('所选项目已不可用，请重新选择')

    const existing = getTodo(input.todoId)
    if (!existing) throw new Error('Todo 不存在')
    if (existing.updatedAt !== input.expectedUpdatedAt) throw new Error(PLANNING_CONFLICT_ERROR)

    const todo = existing.workspaceId === input.workspaceId
      ? existing
      : updateTodo({ id: existing.id, workspaceId: input.workspaceId, expectedUpdatedAt: existing.updatedAt })
    if (!todo) throw new Error('Todo 不存在')
    if (todo !== existing) broadcastPlanningChanged(['todos', 'reminders'])

    const session = createAgentSession(
      `处理：${todo.title}`,
      input.channelId,
      input.workspaceId,
      input.modelId,
      getSettings().agentRuntime ?? 'pi',
    )
    feishuBridgeManager.ensureSessionMirror(session).catch((error) => {
      console.error('[飞书 Session 镜像] Todo 启动会话建群失败:', error)
    })

    try {
      const sourceWindowKind = new URL(event.sender.getURL()).searchParams.get('window')
      if (sourceWindowKind === 'planning') {
        const mainWindow = BrowserWindow.getAllWindows().find((win) => {
          if (win.isDestroyed() || win.webContents.id === event.sender.id) return false
          return new URL(win.webContents.getURL()).searchParams.get('window') === null
        })
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send(PLANNING_IPC_CHANNELS.TODO_AGENT_SESSION_READY, { todo, session })
        }
      }
    } catch (error) {
      console.error('[任务/日程] 转交 Todo Agent 会话到主窗口失败:', error)
    }
    return { todo, session }
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_TODO, async (_, input: UpdateTodoInput): Promise<Todo | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('Todo id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('Todo 标题不能为空且不能超过 500 字')
    if (input.priority !== undefined && !isTodoPriority(input.priority)) throw new Error('Todo priority 非法')
    if (input.status !== undefined && !isTodoStatus(input.status)) throw new Error('Todo status 非法')
    if (input.dueAt !== undefined && input.dueAt !== null && !isPlanningTimestamp(input.dueAt)) throw new Error('Todo dueAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('Todo expectedUpdatedAt 非法')
    if (typeof input.workspaceId === 'string' && input.workspaceId.trim() && !getAgentWorkspace(input.workspaceId)) {
      throw new Error('所选项目已不可用，请重新选择')
    }
    const todo = updateTodo(input)
    if (todo) broadcastPlanningChanged(['todos', 'reminders'])
    return todo
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_TODO, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('Todo id 必填')
    const deleted = deleteTodo(id)
    if (deleted) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS, async (_, input?: unknown): Promise<CalendarEvent[]> => {
    return listCalendarEvents(parseCalendarEventListQuery(input))
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT, async (_, input: CreateCalendarEventInput): Promise<CalendarEvent> => {
    if (!input || !isPlanningTitle(input.title) || !isPlanningTimestamp(input.startAt)) throw new Error('日程标题和 startAt 必填')
    if (input.endAt !== undefined && (!isPlanningTimestamp(input.endAt) || input.endAt < input.startAt)) throw new Error('日程 endAt 非法')
    const event = createCalendarEvent(input)
    broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT, async (_, input: UpdateCalendarEventInput): Promise<CalendarEvent | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id) throw new Error('日程 id 必填')
    if (input.title !== undefined && !isPlanningTitle(input.title)) throw new Error('日程标题不能为空且不能超过 500 字')
    if (input.startAt !== undefined && !isPlanningTimestamp(input.startAt)) throw new Error('日程 startAt 非法')
    if (input.endAt !== undefined && input.endAt !== null && !isPlanningTimestamp(input.endAt)) throw new Error('日程 endAt 非法')
    if (input.expectedUpdatedAt !== undefined && !isPlanningTimestamp(input.expectedUpdatedAt)) throw new Error('日程 expectedUpdatedAt 非法')
    const event = updateCalendarEvent(input)
    if (event) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return event
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('日程 id 必填')
    const deleted = deleteCalendarEvent(id)
    if (deleted) broadcastPlanningChanged(['calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_GROUPS, async (_, scope: PlanningGroupScope, workspaceId?: string): Promise<PlanningGroup[]> => {
    if (!isPlanningGroupScope(scope)) throw new Error('分组范围非法')
    return listPlanningGroups(scope)
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_GROUP, async (_, input: CreatePlanningGroupInput): Promise<PlanningGroup> => {
    if (!input || !isPlanningGroupScope(input.scope) || !isPlanningShortName(input.name) || !isOptionalColor(input.color)) throw new Error('分组参数非法')
    const group = createPlanningGroup(input)
    broadcastPlanningChanged(input.scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders'])
    return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_GROUP, async (_, input: UpdatePlanningGroupInput): Promise<PlanningGroup | undefined> => {
    if (!input || !isPlanningGroupScope(input.scope) || typeof input.id !== 'string' || (input.name !== undefined && !isPlanningShortName(input.name)) || !isOptionalColor(input.color)) throw new Error('分组参数非法')
    const group = updatePlanningGroup(input)
    if (group) broadcastPlanningChanged(input.scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders'])
    return group
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_GROUP, async (_, scope: PlanningGroupScope, id: string, workspaceId?: string): Promise<boolean> => {
    if (!isPlanningGroupScope(scope) || !id || typeof id !== 'string') throw new Error('分组参数非法')
    const deleted = deletePlanningGroup(scope, id)
    if (deleted) broadcastPlanningChanged(scope === 'todo' ? ['todo_groups', 'todos', 'reminders'] : ['calendar_groups', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_TAGS, async (_, workspaceId?: string): Promise<PlanningTag[]> => {
    return listPlanningTags()
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.CREATE_TAG, async (_, input: CreatePlanningTagInput): Promise<PlanningTag> => {
    if (!input || !isPlanningShortName(input.name) || !isOptionalColor(input.color)) throw new Error('标签参数非法')
    const tag = createPlanningTag(input)
    broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return tag
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.UPDATE_TAG, async (_, input: UpdatePlanningTagInput): Promise<PlanningTag | undefined> => {
    if (!input || typeof input.id !== 'string' || !input.id || (input.name !== undefined && !isPlanningShortName(input.name)) || !isOptionalColor(input.color)) throw new Error('标签参数非法')
    const tag = updatePlanningTag(input)
    if (tag) broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return tag
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.DELETE_TAG, async (_, id: string, workspaceId?: string): Promise<boolean> => {
    if (!id || typeof id !== 'string') throw new Error('标签 id 必填')
    const deleted = deletePlanningTag(id)
    if (deleted) broadcastPlanningChanged(['tags', 'todos', 'calendar_events', 'reminders'])
    return deleted
  })

  ipcMain.handle(PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS, async (_, workspaceId?: string): Promise<ActivePlanningReminder[]> => {
    return listActivePlanningReminders()
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER, async (_, id: string, workspaceId?: string): Promise<PlanningReminder | undefined> => {
    if (!id || typeof id !== 'string') throw new Error('提醒 id 必填')
    const reminder = acknowledgePlanningReminder(id)
    if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return reminder
  })
  ipcMain.handle(PLANNING_IPC_CHANNELS.SNOOZE_REMINDER, async (_, input: SnoozePlanningReminderInput, workspaceId?: string): Promise<PlanningReminder | undefined> => {
    if (!input || typeof input.id !== 'string' || !Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 10080) throw new Error('推迟分钟数非法')
    const reminder = snoozePlanningReminder(input.id, input.minutes)
    if (reminder) broadcastPlanningChanged(['todos', 'calendar_events', 'reminders'])
    return reminder
  })
}
