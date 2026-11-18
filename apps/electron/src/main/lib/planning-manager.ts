/** Desktop Planning adapter. The SQL store is host-neutral; paths remain desktop-owned here. */
import { createPlanningStore, type PlanningSqliteDatabase } from '@profer/session-store'
import { getPlanningDatabasePath } from './config-paths'

const store = createPlanningStore({
  databasePath: getPlanningDatabasePath,
  openDatabase(path) {
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => PlanningSqliteDatabase }
    return new DatabaseSync(path)
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
} = store
