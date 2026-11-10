import { expect, test } from 'bun:test'
import { createAgentStopRouter } from './agent-stop-router'

for (const chain of ['runtime', 'legacy'] as const) {
  test(`${chain}: stop 路由与 source 保真，runtime 显式级联`, () => {
    const calls: unknown[] = []
    const stop = createAgentStopRouter({
      runtimeActive: () => chain === 'runtime',
      stopRuntime: (id, reason) => { calls.push(['runtime', id, reason]) },
      stopLegacy: (id, source) => { calls.push(['legacy', id, source]) },
      stopChildren: id => { calls.push(['children', id]) },
      onError: (_id, error) => { throw error },
    })
    stop('child', 'parent_cancel')
    expect(calls[0]).toEqual([chain, 'child', 'parent_cancel'])
    expect(calls.length).toBe(chain === 'runtime' ? 2 : 1)
  })
}

  test('legacy parent owner cascades to runtime child while independent child remains alive', () => {
    const calls: string[] = []
    let running = new Set(['parent', 'subtask-child', 'independent-child'])
    const stop = createAgentStopRouter({
      runtimeActive: sessionId => running.has(sessionId) && sessionId !== 'parent',
      stopRuntime: (id, reason) => { calls.push(`runtime:${id}:${reason}`); running.delete(id) },
      stopLegacy: (id, source) => {
        calls.push(`legacy:${id}:${source}`)
        for (const child of ['subtask-child', 'independent-child']) if (child === 'subtask-child') stop(child, 'parent_cancel')
        running.delete(id)
      },
      stopChildren() {},
      onError: (_id, error) => { throw error },
    })
    stop('parent', 'user')
    expect(calls).toEqual(['legacy:parent:user', 'runtime:subtask-child:parent_cancel'])
    expect(running.has('parent')).toBe(false)
    expect(running.has('subtask-child')).toBe(false)
    expect(running.has('independent-child')).toBe(true)
  })

  test('级联回环不会重复停止当前目标', () => {
  let stops = 0
  const stop = createAgentStopRouter({
    runtimeActive: () => true,
    stopRuntime: () => { stops += 1 },
    stopLegacy() {}, stopChildren: id => stop(id, 'parent_cancel'), onError() {},
  })
  stop('parent')
  expect(stops).toBe(1)
})
