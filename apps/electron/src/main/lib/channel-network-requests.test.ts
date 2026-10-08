import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { CHANNEL_IPC_CHANNELS } from '@profer/shared'
import { ChannelNetworkRequests } from './channel-network-requests'

class FixtureSender extends EventEmitter {
  constructor(readonly id: number, private destroyed = false) { super() }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('destroyed') }
}
const wait = (signal: AbortSignal) => new Promise<string>((resolve) => {
  if (signal.aborted) resolve('cancelled')
  else signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
})

describe('F14：渠道网络请求隔离', () => {
  test('同 requestId 的两个 sender 相互隔离，同 sender 的不同请求独立取消', async () => {
    const scope = new ChannelNetworkRequests()
    const a = new FixtureSender(1)
    const b = new FixtureSender(2)
    const signals: AbortSignal[] = []
    const operation = (signal: AbortSignal) => { signals.push(signal); return wait(signal) }
    const first = scope.run(a, 'same', operation)
    const otherWindow = scope.run(b, 'same', operation)
    const otherRequest = scope.run(a, 'other', operation)
    scope.cancel(a.id, 'same')
    expect(await first).toBe('cancelled')
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false])
    expect(a.listenerCount('destroyed')).toBe(1)
    a.destroy()
    expect(await otherRequest).toBe('cancelled')
    expect(signals[1]!.aborted).toBe(false)
    b.destroy()
    expect(await otherWindow).toBe('cancelled')
    expect(a.listenerCount('destroyed')).toBe(0)
    expect(b.listenerCount('destroyed')).toBe(0)
  })

  test('成功/失败均释放监听和 ID，未知/重复取消幂等，非法/重复 ID 不覆盖已有请求', async () => {
    const scope = new ChannelNetworkRequests()
    const sender = new FixtureSender(1)
    const active = scope.run(sender, 'same', wait)
    await expect(scope.run(sender, 'same', wait)).rejects.toThrow('已在使用')
    await expect(scope.run(sender, 'https://secret.invalid/?key=secret', wait)).rejects.toThrow('标识无效')
    expect(() => scope.cancel(sender.id, '')).toThrow('标识无效')
    scope.cancel(sender.id, 'missing')
    scope.cancel(sender.id, 'same')
    scope.cancel(sender.id, 'same')
    expect(await active).toBe('cancelled')
    expect(await scope.run(sender, 'same', async () => 'success')).toBe('success')
    await expect(scope.run(sender, 'same', async () => { throw new Error('fixture-failure') })).rejects.toThrow('fixture-failure')
    expect(sender.listenerCount('destroyed')).toBe(0)
    const legacy = scope.run(sender, undefined, wait)
    sender.destroy()
    expect(await legacy).toBe('cancelled')
    await expect(scope.run(sender, 'new', wait)).rejects.toThrow('窗口已关闭')
  })
})

test('F14：执行真实 IPC/preload 注册片段，cancel 只取消发起窗口的当前 requestId', async () => {
  const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  // 直接测试连接（无需已保存渠道，传入明文凭证）')
  const end = source.indexOf('  // 查询订阅 Plan 额度', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  const handlers = new Map<string, (event: { sender: FixtureSender }, input: unknown) => Promise<unknown>>()
  const scope = new ChannelNetworkRequests()
  const signals: AbortSignal[] = []
  const service = async (_input: unknown, signal: AbortSignal) => { signals.push(signal); return wait(signal) }
  new Function('deps', `const { ipcMain, CHANNEL_IPC_CHANNELS, channelNetworkRequests, testChannelDirect, fetchModels } = deps; ${js}`)({
    ipcMain: { handle: (name: string, handler: (event: { sender: FixtureSender }, input: unknown) => Promise<unknown>) => handlers.set(name, handler) },
    CHANNEL_IPC_CHANNELS, channelNetworkRequests: scope, testChannelDirect: service, fetchModels: service,
  })
  const preload = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')
  const preloadStart = preload.lastIndexOf('  testChannelDirect: (input:')
  const preloadEnd = preload.indexOf('  getChannelPlanQuota:', preloadStart)
  expect(preloadStart).toBeGreaterThan(0)
  expect(preloadEnd).toBeGreaterThan(preloadStart)
  const methods = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = {${preload.slice(preloadStart, preloadEnd)}};`)
  interface Bridge { testChannelDirect(input: unknown): Promise<unknown>; fetchModels(input: unknown): Promise<unknown>; cancelChannelRequest(id: string): Promise<void> }
  const createBridge = (sender: FixtureSender): Bridge => new Function('ipcRenderer', 'CHANNEL_IPC_CHANNELS', `${methods}; return methods`)(
    { invoke: (name: string, input: unknown) => handlers.get(name)!({ sender }, input) }, CHANNEL_IPC_CHANNELS,
  )
  const a = createBridge(new FixtureSender(1))
  const b = createBridge(new FixtureSender(2))
  const first = a.testChannelDirect({ requestId: 'same' })
  const other = b.fetchModels({ requestId: 'same' })
  await a.cancelChannelRequest('same')
  expect(await first).toBe('cancelled')
  expect(signals[1]!.aborted).toBe(false)
  await b.cancelChannelRequest('same')
  expect(await other).toBe('cancelled')
})
