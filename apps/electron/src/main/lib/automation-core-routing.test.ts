import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AUTOMATION_IPC_CHANNELS } from '@profer/shared'

// 执行生产路由函数，宿主连接与Electron由窄端口替身提供。
const source = readFileSync(new URL('./automation-core-routing.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source).replaceAll('export ', '')
const load = new Function('deps', `const { randomUUID, AUTOMATION_IPC_CHANNELS, getLocalCoreClient, currentCoreId, getActiveCoreClient, getCoreTargetGeneration, getCurrentCoreTargetId, namespaceCoreSessionId, parseCoreSessionId } = deps; ${js}; return { routeAutomationToCore, projectCoreAutomation }`)
function harness() {
  let target = 'remote', generation = 1, connected = true
  let answer: unknown = []
  let pending: Promise<unknown> | undefined
  const calls: unknown[] = []
  const client = { automationRequest: async (operation: string, input: unknown) => { calls.push([operation, input]); return pending ?? answer } }
  const route = load({ getLocalCoreClient: () => null, randomUUID: () => 'fixture-op', AUTOMATION_IPC_CHANNELS, currentCoreId: () => 'A', getActiveCoreClient: () => connected ? client : null,
    getCoreTargetGeneration: () => generation, getCurrentCoreTargetId: () => target,
    namespaceCoreSessionId: (id: string, core: string) => `core:${core}:${id}`,
    parseCoreSessionId: (id: string) => { const match = /^core:([^:]+):(.+)$/.exec(id); return match ? { coreId: match[1], sessionId: match[2] } : null },
  })
  return { calls, route: route.routeAutomationToCore, answer: (value: unknown) => { answer = value }, disconnect: () => { connected = false }, local: () => { target = 'local' }, switch: () => generation++, pending: (value: Promise<unknown>) => { pending = value } }
}
test('Automation远程路由拒绝断线和跨Core ID，只有显式local可走旧路径', async () => {
  const h = harness()
  await expect(h.route(AUTOMATION_IPC_CHANNELS.DELETE, ['core:B:a'])).rejects.toThrow('不属于当前Core')
  await expect(h.route(AUTOMATION_IPC_CHANNELS.DELETE, ['a'])).rejects.toThrow('不属于当前Core')
  h.disconnect()
  await expect(h.route(AUTOMATION_IPC_CHANNELS.LIST, [])).rejects.toThrow('未连接')
  expect(h.calls).toHaveLength(0)
  h.local(); expect(await h.route(AUTOMATION_IPC_CHANNELS.LIST, [])).toBeNull()
})
test('Automation远程投影任务和会话ID，更新时严格还原并保持创建时区', async () => {
  const h = harness()
  h.answer({ id: 'a', boundSessionId: 's', sourceSessionId: 'source', lastSessionId: 'last', runHistory: [{ sessionId: 'last' }], pendingTriggers: [{ targetSessionId: 's' }] })
  const result = await h.route(AUTOMATION_IPC_CHANNELS.UPDATE, [{ id: 'core:A:a', boundSessionId: 'core:A:s' }])
  expect(h.calls).toEqual([['update', { operationId: 'fixture-op', input: { id: 'a', boundSessionId: 's' } }]])
  expect(result.result.id).toBe('core:A:a')
  expect(result.result.runHistory[0].sessionId).toBe('core:A:last')
  expect(result.result.pendingTriggers[0].targetSessionId).toBe('core:A:s')
  await h.route(AUTOMATION_IPC_CHANNELS.CREATE, [{ name: 'fixture', timeZone: 'Asia/Shanghai' }])
  expect(h.calls[1]).toEqual(['create', { operationId: 'fixture-op', input: { name: 'fixture', timeZone: 'Asia/Shanghai' } }])
})
test('Automation切换Core后丢弃迟到响应', async () => {
  const h = harness()
  let resolve!: (value: unknown) => void
  h.pending(new Promise(r => { resolve = r }))
  const result = h.route(AUTOMATION_IPC_CHANNELS.LIST, [])
  h.switch(); resolve([])
  await expect(result).rejects.toThrow('Core已切换')
})
