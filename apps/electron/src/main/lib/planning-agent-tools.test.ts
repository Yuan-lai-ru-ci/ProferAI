import { expect, mock, test } from 'bun:test'

const captured: Array<{ name: string }> = []
mock.module('./planning-agent-operations', () => ({
  createPlanningTodo: mock(async () => ({ id: 'created', title: 'Created' })),
  getPlanningTodo: mock(async () => ({ id: 'todo-1', title: 'Todo', updatedAt: 10 })),
  listPlanningTodos: mock(async () => []),
  updatePlanningTodo: mock(async () => ({ id: 'todo-1', title: 'Updated', updatedAt: 11 })),
}))

const { injectPlanningMcpServer } = await import('./planning-agent-tools')

test('Claude planning MCP exposes list/get/create/update without delete', async () => {
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
  ])
  expect(servers.planning).toBeDefined()
})
