import { describe, expect, mock, test } from 'bun:test'
import { PLANNING_IPC_CHANNELS as C } from '@profer/shared'
let localAttached = false
mock.module('./core-local-bridge', () => ({ getLocalCoreClient: () => localAttached ? client : null }))
let selected = 'local'
let connected = true
let supported = true
let generation = 1
let beforeReply: (() => void) | undefined
const calls: Array<{ operation: string; args: unknown[] }> = []
const client = { planningOperation: async (operation: string, args: unknown[]) => {
  calls.push({ operation, args })
  beforeReply?.()
  if (operation === 'listTodos') return [{ id: 'todo', sessionLinks: [{ sessionId: 'session', firstTouchedAt: 1, lastTouchedAt: 1 }] }]
  return true
} }
mock.module('./planning-events', () => ({ broadcastPlanningChanged: () => undefined }))
mock.module('./core-target-service', () => ({
  getCurrentCoreTargetId: () => selected,
  getActiveCoreClient: () => connected ? client : null,
  currentCoreId: () => connected ? 'owner' : undefined,
  listCoreTargets: () => ({ generation, targets: [{ id: selected, capabilities: supported ? ['planning'] : [] }] }),
  namespaceCoreSessionId: (session: string, owner: string) => `core:${owner}:${session}`,
  parseCoreSessionId: (value: string) => { const match = /^core:([^:]+):(.+)$/.exec(value); return match ? { coreId: match[1], sessionId: match[2] } : null },
}))
const { routePlanningToCore } = await import('./planning-core-routing')

describe('Planning IPC Core ownership', () => {
  test('本机 Core 未就绪和远端断线均不回退旧数据库', async () => {
    selected = 'local'; connected = false
    await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('未连接')
    selected = 'remote'; connected = false
    await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('未连接')
    connected = true; supported = false
    await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('不会回退')
    supported = true
  })
  test('namespaces remote Todo links and validates forwarded session ownership', async () => {
    selected = 'remote'; connected = true; supported = true; calls.length = 0
    const response = await routePlanningToCore(C.LIST_TODOS, [undefined])
    expect((response?.result as Array<{ sessionLinks: Array<{ sessionId: string }> }>)[0]?.sessionLinks[0]?.sessionId).toBe('core:owner:session')
    expect(calls[0]).toEqual({ operation: 'listTodos', args: [] })
    await expect(routePlanningToCore(C.CREATE_TODO, [{ title: 'x', sessionId: 'local-session' }])).rejects.toThrow('不属于当前')
    await expect(routePlanningToCore(C.CREATE_TODO, [{ title: 'x', sessionId: 'core:other:session' }])).rejects.toThrow('不属于当前')
  })
  test('rejects stale responses even when the same target is reselected', async () => {
    selected = 'remote'; connected = true; supported = true
    beforeReply = () => { generation++ }
    try { await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('忽略旧 Core') }
    finally { beforeReply = undefined }
  })

  test('normalizes reminder and legacy optional IPC arguments', async () => {
    selected = 'remote'; connected = true; supported = true; calls.length = 0
    await routePlanningToCore(C.SNOOZE_REMINDER, [{ id: 'reminder', minutes: 5 }, undefined])
    await routePlanningToCore(C.LIST_ACTIVE_REMINDERS, [undefined])
    await routePlanningToCore(C.LIST_TAGS, ['workspace'])
    await routePlanningToCore(C.DELETE_TODO, ['todo', 'workspace'])
    expect(calls).toEqual([
      { operation: 'snoozePlanningReminder', args: ['reminder', 5] },
      { operation: 'listActivePlanningReminders', args: [] },
      { operation: 'listPlanningTags', args: [] },
      { operation: 'deleteTodo', args: ['todo'] },
    ])
  })
})

 test('本机 Core 接管后保留裸会话 ID，未就绪不回退', async () => {
    selected = 'local'; connected = true; supported = true; localAttached = true
    try {
      const response = await routePlanningToCore(C.LIST_TODOS, [])
      expect((response?.result as Array<{ sessionLinks: Array<{ sessionId: string }> }>)[0]?.sessionLinks[0]?.sessionId).toBe('session')
      await routePlanningToCore(C.CREATE_TODO, [{ title: 'x', sessionId: 'session' }])
      expect(calls.at(-1)?.args).toEqual([{ title: 'x', sessionId: 'session' }])
      await expect(routePlanningToCore(C.CREATE_TODO, [{ sessionId: 'core:owner:session' }])).rejects.toThrow('不属于当前')
      connected = false
      await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('未连接')
    } finally { localAttached = false; connected = true }
    connected = false
    try { await expect(routePlanningToCore(C.LIST_TODOS, [])).rejects.toThrow('未连接') }
    finally { connected = true }
 })
