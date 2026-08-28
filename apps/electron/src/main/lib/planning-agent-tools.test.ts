import { expect, mock, test } from 'bun:test'

const captured: Array<{ name: string }> = []
mock.module('./planning-agent-operations', () => ({
  createPlanningTodo: mock(async () => ({ id: 'created', title: 'Created' })),
  getPlanningTodo: mock(async () => ({ id: 'todo-1', title: 'Todo', updatedAt: 10 })),
  listPlanningTodos: mock(async () => []),
  updatePlanningTodo: mock(async () => ({ id: 'todo-1', title: 'Updated', updatedAt: 11 })),
  createPlanningCalendarEvent: mock(async () => ({ id: 'event-1', title: 'Event', startAt: 10, allDay: false })),
  getPlanningCalendarEvent: mock(async () => ({ id: 'event-1', title: 'Event', startAt: 10, allDay: false, updatedAt: 10 })),
  listPlanningCalendarEvents: mock(async () => []),
  updatePlanningCalendarEvent: mock(async () => ({ id: 'event-1', title: 'Updated event', startAt: 10, allDay: false, updatedAt: 11 })),
  deletePlanningCalendarEvent: mock(async () => true),
}))

const { injectPlanningMcpServer } = await import('./planning-agent-tools')

test('Claude planning MCP exposes Todo and local calendar tools', async () => {
  const sdk = {
    createSdkMcpServer(input: { tools: Array<{ name?: string }> }) {
      captured.push(...input.tools.map((tool) => ({ name: tool.name ?? '' })))
      return { name: 'planning' }
    },
    tool(name: string) {
      return { name }
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
  const servers: Record<string, Record<string, unknown>> = {}

  await injectPlanningMcpServer(sdk, servers, { sessionId: 'claude-planning-test' })

  expect(captured.map((tool) => tool.name)).toEqual([
    'list_todos',
    'get_todo',
    'create_todo',
    'update_todo',
    'list_calendar_events',
    'get_calendar_event',
    'create_calendar_event',
    'update_calendar_event',
    'delete_calendar_event',
  ])
  expect(servers.planning).toBeDefined()
})
