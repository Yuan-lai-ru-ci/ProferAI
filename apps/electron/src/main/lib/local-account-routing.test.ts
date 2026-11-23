import { describe, expect, test } from 'bun:test'
import { createLocalAccountRouter } from './local-account-routing'

function fixture() {
  const calls: unknown[][] = []
  const client: { isConnected?: boolean; accountOperation<T>(operation: string, args?: unknown[]): Promise<T>; addAccountEventListener?: (listener: () => void) => () => void; addWorkspaceEventListener?: (listener: () => void) => () => void } = { async accountOperation<T>(operation: string, args: unknown[] = []): Promise<T> {
    calls.push([operation, args])
    return (operation === 'status' ? { isLoggedIn: true, commercialMode: true } : operation === 'teamAuth' ? { baseUrl: 'http://synthetic', token: 'synthetic', membershipTier: 'plus' } : { success: true }) as T
  } }
  const accountListeners = new Set<() => void>()
  const workspaceListeners = new Set<() => void>()
  client.addAccountEventListener = (fn: () => void) => { accountListeners.add(fn); return () => accountListeners.delete(fn) }
  client.addWorkspaceEventListener = (fn: () => void) => { workspaceListeners.add(fn); return () => workspaceListeners.delete(fn) }
  let current: typeof client | null = client
  let independent = true
  const router = createLocalAccountRouter({ independent: () => independent, client: () => current })
  return { router, client, calls, accountListeners, workspaceListeners, setClient: (value: typeof client | null) => { current = value }, setIndependent: (value: boolean) => { independent = value } }
}

describe('本机 owner 账号路由', () => {
  test('参数保持原样，只读取注入的本机 owner，不读取当前远端目标', async () => {
    const f = fixture()
    await f.router.operation('login', ['synthetic@example.invalid', 'not-a-real-password', undefined])
    expect(f.calls).toEqual([['login', ['synthetic@example.invalid', 'not-a-real-password', undefined]], ['status', []], ['teamAuth', []]])
    expect(f.router.snapshot().auth?.membershipTier).toBe('plus')
  })
  test('离线不使用旧快照，不回退到桌面磁盘', async () => {
    const f = fixture()
    await f.router.operation('status')
    f.setClient(null)
    expect(() => f.router.snapshot()).toThrow('未连接')
    expect(() => f.router.operation('login')).toThrow('未连接')
  })
  test('晚到的实例结果丢弃', async () => {
    const f = fixture()
    let resolve!: (value: unknown) => void
    f.client.accountOperation = <T>() => new Promise<T>(done => { resolve = done as (value: unknown) => void })
    const pending = f.router.operation('login')
    await Promise.resolve()
    f.setClient({ accountOperation: async <T>() => ({}) as T })
    resolve({ success: true })
    await expect(pending).rejects.toThrow('已切换')
    expect(() => f.router.snapshot()).toThrow('尚未加载')
  })
  test('并发读按序完成，不互相失效', async () => {
    const f = fixture()
    await Promise.all([f.router.operation('status'), f.router.operation('registrationOptions')])
    expect(f.router.snapshot().status.isLoggedIn).toBe(true)
  })
  test('返回内置模式后不再读取独立快照', async () => {
    const f = fixture()
    await f.router.operation('status')
    f.setIndependent(false)
    expect(() => f.router.snapshot()).toThrow('未连接')
  })
  test('断连使缓存失效，重连后同步 getter 自动恢复', async () => {
    const f = fixture()
    await f.router.operation('status')
    f.client.isConnected = false
    for (const listener of f.accountListeners) listener()
    f.setClient(null)
    expect(() => f.router.snapshot()).toThrow('未连接')
    const next = { ...f.client, isConnected: true }
    f.setClient(next)
    expect(() => f.router.snapshot()).toThrow('尚未加载')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.router.snapshot().status.isLoggedIn).toBe(true)
  })
  test('后台账号变化通过workspace事件重新查询，无token事件广播', async () => {
    const f = fixture()
    await f.router.operation('status')
    const before = f.calls.length
    for (const listener of f.workspaceListeners) listener()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.calls.slice(before)).toEqual([['status', []], ['teamAuth', []]])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.calls.length).toBe(before + 2)
  })
  test('同步快照过程中遇后台变更时丢弃旧回复，再恢复权威状态', async () => {
    const f = fixture()
    await f.router.operation('status')
    let release!: (value: unknown) => void
    const original = f.client.accountOperation.bind(f.client)
    let holdNext = true
    f.client.accountOperation = <T>(operation: string, args: unknown[] = []) => {
      if (holdNext && operation === 'teamAuth') { holdNext = false; return new Promise<T>(resolve => { release = resolve as (value: unknown) => void }) }
      return original<T>(operation, args)
    }
    for (const listener of f.workspaceListeners) listener()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(typeof release).toBe('function')
    for (const listener of f.workspaceListeners) listener()
    release({ baseUrl: 'stale', token: 'stale' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.router.snapshot().auth?.token).toBe('synthetic')
  })
})
