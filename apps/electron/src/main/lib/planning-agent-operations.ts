/** Desktop event and storage adapter for shared Planning Agent operations. */
import { createPlanningAgentOperations } from '@profer/session-store'
import * as store from './planning-manager'
import { broadcastPlanningAgentOperation, broadcastPlanningChanged } from './planning-events'
export type { PlanningAgentToolContext } from '@profer/session-store'

export const {
  listPlanningTodos,
  getPlanningTodo,
  createPlanningTodo,
  updatePlanningTodo,
  listPlanningCalendarEvents,
  getPlanningCalendarEvent,
  createPlanningCalendarEvent,
  updatePlanningCalendarEvent,
  deletePlanningCalendarEvent,
} = createPlanningAgentOperations(store, { broadcastPlanningChanged, broadcastPlanningAgentOperation })
