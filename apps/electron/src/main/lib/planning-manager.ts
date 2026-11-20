/** Desktop Planning adapter. The SQL store is host-neutral; paths remain desktop-owned here. */
import { createPlanningStore, type PlanningSqliteDatabase } from '@profer/session-store'
import { localCoreOwnsBusinessData } from './core-business-ownership'
import { getCurrentCoreTargetId } from './core-target-service'
import { getPlanningDatabasePath } from './config-paths'

const store = createPlanningStore({
  databasePath: getPlanningDatabasePath,
  openDatabase(path) {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => PlanningSqliteDatabase }
    return new DatabaseSync(path)
  },
})

const coreOwnsPlanning = (): boolean => localCoreOwnsBusinessData() || getCurrentCoreTargetId() !== 'local'

// 宿主提醒轮询不再领取 Core 的业务提醒；Core 事件负责通知，桌面不二次决策。
const desktopStore = new Proxy(store, {
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver)
    if (typeof value !== 'function') return value
    return (...args: unknown[]): unknown => {
      if (coreOwnsPlanning() && property !== 'closePlanningDatabase') {
        if (property === 'claimDuePlanningReminders') return []
        throw new Error('CORE_PLANNING_OWNED: 任务/日程已由 Core 接管，请通过 Core 操作')
      }
      return Reflect.apply(value, target, args)
    }
  },
})

export const {
  closePlanningDatabase,
  reloadPlanningDatabase,
  listPlanningGroups,
  createPlanningGroup,
  updatePlanningGroup,
  deletePlanningGroup,
  listPlanningTags,
  createPlanningTag,
  updatePlanningTag,
  deletePlanningTag,
  listTodos,
  getTodo,
  touchTodoSession,
  createTodo,
  updateTodo,
  deleteTodo,
  listCalendarEvents,
  getCalendarEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  createPlanningReminder,
  deletePlanningReminder,
  updatePlanningReminder,
  acknowledgePlanningReminder,
  snoozePlanningReminder,
  listActivePlanningReminders,
  claimDuePlanningReminders,
} = desktopStore
