import { fetch as undiciFetch } from 'undici'
import { getTeamAuth, refreshAuthToken } from './auth-service'
import type { ActivePlanningReminder, CalendarEvent, CreateCalendarEventInput, CreatePlanningGroupInput, CreatePlanningTagInput, CreateTodoInput, PlanningGroup, PlanningGroupScope, PlanningTag, SnoozePlanningReminderInput, Todo, UpdateCalendarEventInput, UpdatePlanningGroupInput, UpdatePlanningTagInput, UpdateTodoInput } from '@profer/shared'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let auth = getTeamAuth()
  if (!auth) { await refreshAuthToken().catch(() => {}); auth = getTeamAuth() }
  if (!auth) throw new Error('未登录团队服务')
  const run = (current: NonNullable<typeof auth>) => (undiciFetch as unknown as typeof fetch)(`${current.baseUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) } })
  let response = await run(auth)
  if (response.status === 401 && await refreshAuthToken()) { const next = getTeamAuth(); if (next) response = await run(next) }
  if (!response.ok) { const data = await response.json().catch(() => null) as { error?: string; code?: string } | null; const error = new Error(data?.error ?? `团队规划请求失败 (${response.status})`) as Error & { code?: string; status?: number }; error.code = data?.code; error.status = response.status; throw error }
  return response.json() as Promise<T>
}
export async function listTeamTodos(workspaceId: string): Promise<Todo[]> { return (await request<Todo[]>(`/v1/workspaces/${workspaceId}/planning/todos`)).map((todo) => ({ ...todo, workspaceId })) }
export async function createTeamTodo(workspaceId: string, input: CreateTodoInput): Promise<Todo> { return { ...(await request<Todo>(`/v1/workspaces/${workspaceId}/planning/todos`, { method: 'POST', body: JSON.stringify(input) })), workspaceId } }
export async function updateTeamTodo(workspaceId: string, input: UpdateTodoInput): Promise<Todo> { return { ...(await request<Todo>(`/v1/workspaces/${workspaceId}/planning/todos/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })), workspaceId } }
export function deleteTeamTodo(workspaceId: string, id: string): Promise<void> { return request(`/v1/workspaces/${workspaceId}/planning/todos/${id}`, { method: 'DELETE' }) }
export function listTeamPlanningGroups(workspaceId: string, scope: PlanningGroupScope): Promise<PlanningGroup[]> { return request(`/v1/workspaces/${workspaceId}/planning/groups?scope=${scope}`) }
export function createTeamPlanningGroup(workspaceId: string, input: CreatePlanningGroupInput): Promise<PlanningGroup> { return request(`/v1/workspaces/${workspaceId}/planning/groups`, { method: 'POST', body: JSON.stringify(input) }) }
export function updateTeamPlanningGroup(workspaceId: string, input: UpdatePlanningGroupInput): Promise<PlanningGroup> { return request(`/v1/workspaces/${workspaceId}/planning/groups/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) }) }
export function deleteTeamPlanningGroup(workspaceId: string, scope: PlanningGroupScope, id: string): Promise<void> { return request(`/v1/workspaces/${workspaceId}/planning/groups/${id}`, { method: 'DELETE', body: JSON.stringify({ scope }) }) }
export function listTeamPlanningTags(workspaceId: string): Promise<PlanningTag[]> { return request(`/v1/workspaces/${workspaceId}/planning/tags`) }
export function createTeamPlanningTag(workspaceId: string, input: CreatePlanningTagInput): Promise<PlanningTag> { return request(`/v1/workspaces/${workspaceId}/planning/tags`, { method: 'POST', body: JSON.stringify(input) }) }
export function updateTeamPlanningTag(workspaceId: string, input: UpdatePlanningTagInput): Promise<PlanningTag> { return request(`/v1/workspaces/${workspaceId}/planning/tags/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) }) }
export function deleteTeamPlanningTag(workspaceId: string, id: string): Promise<void> { return request(`/v1/workspaces/${workspaceId}/planning/tags/${id}`, { method: 'DELETE' }) }
export async function listTeamCalendarEvents(workspaceId: string): Promise<CalendarEvent[]> { return (await request<CalendarEvent[]>(`/v1/workspaces/${workspaceId}/planning/calendar-events`)).map((event) => ({ ...event, workspaceId })) }
export async function createTeamCalendarEvent(workspaceId: string, input: CreateCalendarEventInput): Promise<CalendarEvent> { return { ...(await request<CalendarEvent>(`/v1/workspaces/${workspaceId}/planning/calendar-events`, { method: 'POST', body: JSON.stringify(input) })), workspaceId } }
export async function updateTeamCalendarEvent(workspaceId: string, input: UpdateCalendarEventInput): Promise<CalendarEvent> { return { ...(await request<CalendarEvent>(`/v1/workspaces/${workspaceId}/planning/calendar-events/${input.id}`, { method: 'PATCH', body: JSON.stringify(input) })), workspaceId } }
export function deleteTeamCalendarEvent(workspaceId: string, id: string): Promise<void> { return request(`/v1/workspaces/${workspaceId}/planning/calendar-events/${id}`, { method: 'DELETE' }) }
export async function listTeamActiveReminders(workspaceId: string): Promise<ActivePlanningReminder[]> {
  const rows = await request<Array<{ id: string; target_type: 'todo' | 'calendar_event'; target_id: string; target_title: string; trigger_at: number; snoozed_until?: number; status: 'pending' }>>(`/v1/workspaces/${workspaceId}/planning/reminder-deliveries/active`)
  return rows.map((row) => ({ id: row.id, targetType: row.target_type, targetId: row.target_id, targetTitle: row.target_title, triggerAt: row.trigger_at, snoozedUntil: row.snoozed_until, status: row.status, origin: 'manual', tags: [], createdAt: row.trigger_at, updatedAt: row.trigger_at }))
}
export function acknowledgeTeamReminder(workspaceId: string, id: string): Promise<{ success: boolean }> { return request(`/v1/workspaces/${workspaceId}/planning/reminder-deliveries/${id}/acknowledge`, { method: 'POST' }) }
export function snoozeTeamReminder(workspaceId: string, input: SnoozePlanningReminderInput): Promise<{ success: boolean }> { return request(`/v1/workspaces/${workspaceId}/planning/reminder-deliveries/${input.id}/snooze`, { method: 'POST', body: JSON.stringify({ minutes: input.minutes }) }) }
