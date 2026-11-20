import { expect, mock, test } from 'bun:test'
let selected = 'local', connected = true, generation = 1
let beforeReply: (() => void) | undefined
const calls: unknown[] = []
const state = { id: 'goal-1', sessionId: 'session-1', status: 'active' }
const client = {
  goalRequest: async (operation: string, input?: unknown) => { calls.push({ operation, input }); beforeReply?.(); return operation === 'list' || operation === 'history' ? [state] : state },
  listGoals: async (sessionId: string) => { calls.push({ operation: 'list-session', sessionId }); beforeReply?.(); return [state] },
}
mock.module('./core-target-service', () => ({
  getCurrentCoreTargetId: () => selected,
  getActiveCoreClient: () => connected ? client : null,
  getCoreTargetGeneration: () => generation,
  currentCoreId: () => 'owner',
  namespaceCoreSessionId: (id: string, core: string) => `core:${core}:${id}`,
  parseCoreSessionId: (value: string) => { const match = /^core:([^:]+):(.+)$/.exec(value); return match ? { coreId: match[1], sessionId: match[2] } : null },
}))
const { routeGoalToCore } = await import('./goal-core-routing')
test('Goal仅显式本机返回null，断线/归属错误不回退', async () => {
  expect(await routeGoalToCore('list')).toBeNull()
  selected = 'remote'; connected = false
  await expect(routeGoalToCore('list')).rejects.toThrow('未连接')
  connected = true
  await expect(routeGoalToCore('pause', 'local')).rejects.toThrow('不属于')
  await expect(routeGoalToCore('pause', 'core:other:session-1')).rejects.toThrow('不属于')
})
test('Goal创建/查询/控制只向所属Core发送，并投影会话命名空间', async () => {
  selected = 'remote'; connected = true; calls.length = 0
  expect(await routeGoalToCore('start', 'core:owner:session-1', { goal: 'fixture' })).toMatchObject({ result: { sessionId: 'core:owner:session-1' } })
  expect(calls[0]).toEqual({ operation: 'start', input: { sessionId: 'session-1', goal: 'fixture' } })
  await routeGoalToCore('pause', 'core:owner:session-1')
  expect(calls.at(-1)).toEqual({ operation: 'pause', input: { goalId: 'goal-1' } })
  expect(await routeGoalToCore('get', 'core:owner:session-1')).toMatchObject({ result: { id: 'goal-1', sessionId: 'core:owner:session-1' } })
})
test('同目标重选也拒绝旧Core响应', async () => {
  beforeReply = () => generation++
  try { await expect(routeGoalToCore('list')).rejects.toThrow('忽略旧Goal') }
  finally { beforeReply = undefined }
})
