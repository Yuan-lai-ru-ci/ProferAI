import { localCoreOwnsBusinessData } from './core-business-ownership'
import { broadcastPlanningChanged } from './planning-events'
import { PLANNING_IPC_CHANNELS, type StartTodoAgentResult, type Todo } from '@profer/shared'
import { currentCoreId, getActiveCoreClient, getCurrentCoreTargetId, listCoreTargets, namespaceCoreSessionId, parseCoreSessionId } from './core-target-service'

const OPERATIONS: Record<string, string> = {
  [PLANNING_IPC_CHANNELS.START_TODO_AGENT]: 'startTodoAgent',
  [PLANNING_IPC_CHANNELS.LIST_TODOS]: 'listTodos',
  [PLANNING_IPC_CHANNELS.CREATE_TODO]: 'createTodo',
  [PLANNING_IPC_CHANNELS.UPDATE_TODO]: 'updateTodo',
  [PLANNING_IPC_CHANNELS.DELETE_TODO]: 'deleteTodo',
  [PLANNING_IPC_CHANNELS.LIST_CALENDAR_EVENTS]: 'listCalendarEvents',
  [PLANNING_IPC_CHANNELS.CREATE_CALENDAR_EVENT]: 'createCalendarEvent',
  [PLANNING_IPC_CHANNELS.UPDATE_CALENDAR_EVENT]: 'updateCalendarEvent',
  [PLANNING_IPC_CHANNELS.DELETE_CALENDAR_EVENT]: 'deleteCalendarEvent',
  [PLANNING_IPC_CHANNELS.LIST_GROUPS]: 'listPlanningGroups',
  [PLANNING_IPC_CHANNELS.CREATE_GROUP]: 'createPlanningGroup',
  [PLANNING_IPC_CHANNELS.UPDATE_GROUP]: 'updatePlanningGroup',
  [PLANNING_IPC_CHANNELS.DELETE_GROUP]: 'deletePlanningGroup',
  [PLANNING_IPC_CHANNELS.LIST_TAGS]: 'listPlanningTags',
  [PLANNING_IPC_CHANNELS.CREATE_TAG]: 'createPlanningTag',
  [PLANNING_IPC_CHANNELS.UPDATE_TAG]: 'updatePlanningTag',
  [PLANNING_IPC_CHANNELS.DELETE_TAG]: 'deletePlanningTag',
  [PLANNING_IPC_CHANNELS.LIST_ACTIVE_REMINDERS]: 'listActivePlanningReminders',
  [PLANNING_IPC_CHANNELS.ACKNOWLEDGE_REMINDER]: 'acknowledgePlanningReminder',
  [PLANNING_IPC_CHANNELS.SNOOZE_REMINDER]: 'snoozePlanningReminder',
}

/** 只有未启用 Core 的旧桌面链可回本机数据库；Core 断连不回退。 */
export async function routePlanningToCore(channel: string, args: unknown[]): Promise<{ result: unknown } | null> {
  const targetId = getCurrentCoreTargetId()
  const local = targetId === 'local'
  if (local && !localCoreOwnsBusinessData()) return null
  const snapshot = listCoreTargets()
  const target = snapshot.targets.find(item => item.id === targetId)
  const client = getActiveCoreClient()
  const coreId = currentCoreId()
  if (!client || (!local && !coreId)) throw new Error('当前 Core 未连接，不能访问任务/日程')
  if (!target?.capabilities?.includes('planning')) throw new Error('当前 Core 尚不支持任务/日程，请更新 Core；不会回退到本机数据')
  const operation = OPERATIONS[channel]
  if (!operation) throw new Error('当前 Core 尚不支持此 Planning 操作')
  const forwarded = args.slice()
  while (forwarded.length && forwarded[forwarded.length - 1] === undefined) forwarded.pop()
  if (operation === 'snoozePlanningReminder') {
    const input = forwarded[0] as { id?: unknown; minutes?: unknown } | undefined
    forwarded.splice(0, forwarded.length, input?.id, input?.minutes)
  }
  if (operation === 'listActivePlanningReminders') forwarded.splice(0)
  if (operation === 'acknowledgePlanningReminder') forwarded.splice(1)
  // Legacy IPC includes ignored workspace arguments on deletes/group/tag queries.
  if (['deleteTodo', 'deleteCalendarEvent', 'listPlanningGroups', 'listPlanningTags', 'deletePlanningTag'].includes(operation)) {
    forwarded.splice(operation === 'listPlanningTags' ? 0 : 1)
  }
  if (operation === 'deletePlanningGroup') forwarded.splice(2)
  const input = forwarded[0]
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = { ...input } as Record<string, unknown>
    if (record.sessionId !== undefined) {
      const owner = typeof record.sessionId === 'string' ? parseCoreSessionId(record.sessionId) : null
      if (local ? owner !== null || typeof record.sessionId !== 'string' || !record.sessionId : !owner || owner.coreId !== coreId) throw new Error('Planning 会话不属于当前 Core')
      if (!local && owner) record.sessionId = owner.sessionId
    }
    forwarded[0] = record
  }
  const result = await client.planningOperation<unknown>(operation, forwarded)
  if (getCurrentCoreTargetId() !== targetId || getActiveCoreClient() !== client || listCoreTargets().generation !== snapshot.generation) throw new Error('Core 已切换，忽略旧 Core 的任务/日程响应')
  if (!operation.startsWith('list')) broadcastPlanningChanged()
  if (local) return { result: result ?? undefined }
  if (!coreId) throw new Error('当前 Core 未连接')
  const namespace = (todo: Todo): Todo => ({ ...todo, sessionLinks: todo.sessionLinks.map(link => ({ ...link, sessionId: namespaceCoreSessionId(link.sessionId, coreId) })) })
  if (operation === 'startTodoAgent') {
    const started = result as StartTodoAgentResult
    return { result: { todo: namespace(started.todo), session: { ...started.session, id: namespaceCoreSessionId(started.session.id, coreId) } } }
  }
  if (operation === 'listTodos' || operation === 'createTodo' || operation === 'updateTodo') {
    return { result: Array.isArray(result) ? result.map(todo => namespace(todo as Todo)) : result ? namespace(result as Todo) : undefined }
  }
  return { result: result ?? undefined }
}
