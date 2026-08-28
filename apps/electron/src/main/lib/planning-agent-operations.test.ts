import { describe, expect, mock, test } from 'bun:test'

const localTodo = {
  id: 'local-1',
  title: '本地 Todo',
  status: 'open' as const,
  priority: 'medium' as const,
  tags: [],
  reminders: [],
  sessionLinks: [],
  workspaceId: 'personal-ws',
  createdAt: 1,
  updatedAt: 10,
}
const teamTodo = { ...localTodo, id: 'team-1', title: '团队 Todo', workspaceId: 'team-ws', updatedAt: 20 }
const localCalendarEvent = { id: 'calendar-1', title: '本地日程', startAt: 100, endAt: 200, allDay: false, tags: [], reminders: [], workspaceId: 'personal-ws', createdAt: 1, updatedAt: 10 }
const teamCalendarEvent = { ...localCalendarEvent, id: 'team-calendar-1', title: '团队日程', workspaceId: 'team-ws', updatedAt: 20 }
const events: unknown[] = []

mock.module('./planning-manager', () => ({
  createTodo: mock(() => localTodo),
  getTodo: mock((id: string) => id === localTodo.id ? localTodo : undefined),
  listTodos: mock(() => [localTodo]),
  touchTodoSession: mock(() => undefined),
  updateTodo: mock(() => ({ ...localTodo, title: '已更新', updatedAt: 11 })),
  createCalendarEvent: mock(() => localCalendarEvent),
  getCalendarEvent: mock((id: string) => id === localCalendarEvent.id ? localCalendarEvent : undefined),
  listCalendarEvents: mock(() => [localCalendarEvent]),
  updateCalendarEvent: mock(() => ({ ...localCalendarEvent, title: '日程已更新', updatedAt: 11 })),
  deleteCalendarEvent: mock(() => true),
}))
mock.module('./team-planning-service', () => ({
  createTeamTodo: mock(async () => teamTodo),
  listTeamTodos: mock(async () => [teamTodo]),
  updateTeamTodo: mock(async () => ({ ...teamTodo, title: '团队已更新', updatedAt: 21 })),
  createTeamCalendarEvent: mock(async () => teamCalendarEvent),
  listTeamCalendarEvents: mock(async () => [teamCalendarEvent]),
  updateTeamCalendarEvent: mock(async () => ({ ...teamCalendarEvent, title: '团队日程已更新', updatedAt: 21 })),
  deleteTeamCalendarEvent: mock(async () => undefined),
}))
mock.module('./planning-events', () => ({
  broadcastPlanningChanged: mock((resources: unknown) => events.push(['changed', resources])),
  broadcastPlanningAgentOperation: mock((operation: unknown) => events.push(['agent', operation])),
}))

const { createPlanningCalendarEvent, createPlanningTodo, deletePlanningCalendarEvent, getPlanningCalendarEvent, getPlanningTodo, listPlanningCalendarEvents, listPlanningTodos, updatePlanningCalendarEvent, updatePlanningTodo } = await import('./planning-agent-operations')

describe('planning-agent-operations', () => {
  test('本地工作区路由 Todo 读写并广播 Agent 操作', async () => {
    events.length = 0
    const ctx = { sessionId: 'session-local', workspaceId: 'personal-ws', isTeamWorkspace: false }

    expect(await listPlanningTodos(ctx)).toEqual([localTodo])
    expect(await getPlanningTodo(ctx, localTodo.id)).toEqual(localTodo)
    expect((await createPlanningTodo(ctx, { title: '新任务' })).title).toBe('本地 Todo')
    expect((await updatePlanningTodo(ctx, { id: localTodo.id, expectedUpdatedAt: 10, title: '改标题' })).title).toBe('已更新')
    expect(events.filter((event) => Array.isArray(event) && event[0] === 'agent')).toHaveLength(2)
  })

  test('团队工作区路由 Team Server，且不越过当前工作区读取', async () => {
    const ctx = { sessionId: 'session-team', workspaceId: 'team-ws', isTeamWorkspace: true }
    expect(await listPlanningTodos(ctx)).toEqual([teamTodo])
    expect(await getPlanningTodo(ctx, teamTodo.id)).toEqual(teamTodo)
    expect((await createPlanningTodo(ctx, { title: '新团队任务' })).workspaceId).toBe('team-ws')
    expect((await updatePlanningTodo(ctx, { id: teamTodo.id, expectedUpdatedAt: 20, title: '改团队标题' })).workspaceId).toBe('team-ws')
    await expect(getPlanningTodo(ctx, localTodo.id)).rejects.toThrow('Todo 不存在')
  })

  test('更新缺少 expectedUpdatedAt 时拒绝覆盖 Todo', async () => {
    await expect(updatePlanningTodo({ sessionId: 'session-local', workspaceId: 'personal-ws' }, { id: localTodo.id })).rejects.toThrow('expectedUpdatedAt')
  })

  test('本地日程路由读写并广播 Agent 操作', async () => {
    events.length = 0
    const ctx = { sessionId: 'session-calendar', workspaceId: 'personal-ws', isTeamWorkspace: false }
    expect(await listPlanningCalendarEvents(ctx, { from: 50, to: 250 })).toEqual([localCalendarEvent])
    expect(await getPlanningCalendarEvent(ctx, localCalendarEvent.id)).toEqual(localCalendarEvent)
    expect((await createPlanningCalendarEvent(ctx, { title: '新日程', startAt: 300 })).title).toBe('本地日程')
    expect((await updatePlanningCalendarEvent(ctx, { id: localCalendarEvent.id, expectedUpdatedAt: 10, title: '改日程' })).title).toBe('日程已更新')
    expect(await deletePlanningCalendarEvent(ctx, localCalendarEvent.id)).toBe(true)
    expect(events.filter((event) => Array.isArray(event) && event[0] === 'agent')).toHaveLength(3)
  })

  test('团队日程路由到 Team Server 且隔离工作区', async () => {
    const ctx = { sessionId: 'session-team-calendar', workspaceId: 'team-ws', isTeamWorkspace: true }
    expect(await listPlanningCalendarEvents(ctx)).toEqual([teamCalendarEvent])
    expect(await createPlanningCalendarEvent(ctx, { title: '新团队日程', startAt: 300 })).toEqual(teamCalendarEvent)
    await expect(getPlanningCalendarEvent(ctx, localCalendarEvent.id)).rejects.toThrow('日程不存在')
  })
})
