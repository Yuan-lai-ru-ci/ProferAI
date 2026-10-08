import { describe, expect, test } from 'bun:test'
import type { AgentStreamEvent, Channel } from '@profer/shared'
import { subscribeChannelCatalog } from './channel-catalog-listener'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const channel: Channel = { id: 'fixture', name: 'Fixture', provider: 'custom', apiKey: 'encrypted',
  baseUrl: 'https://fixture.invalid', models: [], enabled: true, createdAt: 1, updatedAt: 1 }
function setup(initialRefresh = false, guardSnapshot = false) {
  let snapshot: Channel[] = []
  let initialReads = 0
  let accountChanges = 0
  let listener!: (event: AgentStreamEvent) => void
  let accountListener!: () => void
  let refreshListener!: () => void
  let account = { isLoggedIn: true, teamAccountId: 'a' }
  const requests: ReturnType<typeof deferred<Channel[]>>[] = []
  const applied: Channel[][] = []
  const failures: unknown[] = []
  let removed = 0
  const cleanup = subscribeChannelCatalog({
    subscribe: (fn) => { listener = fn; return () => { removed += 1 } },
    subscribeAccount: (fn) => { accountListener = fn; return () => { removed += 1 } },
    getAccount: () => account,
    subscribeRefresh: (callback) => { refreshListener = callback; return () => { removed += 1 } },
    listLocalChannels: () => { const request = deferred<Channel[]>(); requests.push(request); return request.promise },
    listInitialChannels: () => { initialReads += 1; const request = deferred<Channel[]>(); requests.push(request); return request.promise },
    getCatalogSnapshot: guardSnapshot ? () => snapshot : undefined,
    onAccountChange: () => { accountChanges += 1; snapshot = [] },
    initialRefresh,
    apply: (channels) => { snapshot = channels; applied.push(channels) }, onFailure: (error) => failures.push(error),
  })
  const emit = (revision: number, catalog: 'channels' | 'presets' = 'channels') => listener({
    sessionId: 'catalog:channels:*', payload: { kind: 'catalog_invalidation', catalog, workspaceSlug: null, revision, changedAt: 1 },
  })
  return { emit, cleanup, refresh: () => refreshListener(), requests, applied, failures, initialReads: () => initialReads, accountChanges: () => accountChanges,
    snapshot: (next: Channel[]) => { snapshot = next }, removed: () => removed,
    account: (next: typeof account) => { account = next; accountListener() } }
}
describe('Renderer 渠道目录订阅', () => {
  test('Given 弹窗刷新 When 旧刷新尚未返回 Then 统一代际只读本地，新回执保留且不启动远端同步', async () => {
    const scope = setup(true)
    scope.refresh()
    scope.refresh()
    scope.requests[2]!.resolve([{ ...channel, id: 'opened' }])
    await Promise.resolve()
    scope.requests[1]!.resolve([channel]); scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([[{ ...channel, id: 'opened' }]])
    expect(scope.initialReads()).toBe(1)
    scope.cleanup()
    scope.refresh()
    expect(scope.requests).toHaveLength(3)
  })

  test('Given 启动LIST未返回 When 新catalog返回 Then 晚启动水合不覆盖，新事件只读本地不触发同步loop', async () => {
    const scope = setup(true)
    expect(scope.initialReads()).toBe(1)
    scope.emit(1)
    scope.requests[1]!.resolve([{ ...channel, id: 'fresh' }])
    await Promise.resolve()
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([[{ ...channel, id: 'fresh' }]])
    expect(scope.initialReads()).toBe(1)
    expect(scope.requests).toHaveLength(2)
    scope.cleanup()
  })
  test('Given 启动读取 When 设置页已经写入新atom快照 Then 迟到目录不覆盖', async () => {
    const scope = setup(true, true)
    const edited = [{ ...channel, id: 'edited' }]
    scope.snapshot(edited)
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([edited])
    scope.cleanup()
  })
  test('Given 启动A请求 When A→B→A Then 同步触发按新账号代际，只有最后目录可写', async () => {
    const scope = setup(true, true)
    scope.account({ isLoggedIn: true, teamAccountId: 'b' })
    scope.account({ isLoggedIn: true, teamAccountId: 'a' })
    scope.requests[2]!.resolve([{ ...channel, id: 'last-a' }])
    await Promise.resolve()
    scope.requests[1]!.resolve([{ ...channel, id: 'b' }])
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([[{ ...channel, id: 'last-a' }]])
    expect(scope.accountChanges()).toBe(2)
    expect(scope.initialReads()).toBe(3)
    scope.cleanup()
  })

  test('Given 目录失效 When 重复/乱序和其他目录事件 Then 只消费递增的 channels 事件', async () => {
    const scope = setup()
    scope.emit(1)
    scope.emit(1)
    scope.emit(0)
    scope.emit(2, 'presets')
    expect(scope.requests).toHaveLength(1)
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([[channel]])
    scope.cleanup()
    scope.cleanup()
    expect(scope.removed()).toBe(3)
    scope.emit(3)
    expect(scope.requests).toHaveLength(1)
  })
  test('Given 旧请求 When 更高 revision 完成后旧请求返回 Then 不覆盖新目录', async () => {
    const scope = setup()
    scope.emit(1)
    scope.emit(2)
    const newer = { ...channel, id: 'new' }
    scope.requests[1]!.resolve([newer])
    await Promise.resolve()
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([[newer]])
    scope.cleanup()
  })
  test('Given A 请求 When A→B→A 或登出 Then 旧代际不写回且登出过滤官方缓存', async () => {
    const scope = setup()
    scope.emit(1)
    scope.account({ isLoggedIn: true, teamAccountId: 'b' })
    scope.account({ isLoggedIn: true, teamAccountId: 'a' })
    scope.requests[0]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([])
    scope.account({ isLoggedIn: false, teamAccountId: '' })
    scope.requests[3]!.resolve([channel, { ...channel, id: 'newapi-old', serverManaged: true }])
    await Promise.resolve()
    expect(scope.applied).toEqual([[channel]])
    scope.cleanup()
  })
  test('Given 加载失败/卸载 When 旧结果完成 Then 保留现有目录且不写回', async () => {
    const scope = setup()
    scope.emit(1)
    scope.requests[0]!.reject(new Error('fixture-read-failure'))
    await Promise.resolve(); await Promise.resolve()
    expect(scope.failures).toHaveLength(1)
    expect(scope.applied).toEqual([])
    scope.emit(2)
    scope.cleanup()
    scope.requests[1]!.resolve([channel])
    await Promise.resolve()
    expect(scope.applied).toEqual([])
  })
})
