import { afterAll, describe, expect, mock, test } from 'bun:test'
import { app, safeStorage } from 'electron'
import { AGENT_IPC_CHANNELS as C_CHANNEL } from '@profer/shared'
import type { CoreAgentEvent } from './core-client'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'profer-core-target-lifecycle-'))
const storePath = join(root, 'core-targets.json')
const { CoreClientError } = await import('./core-client')
const rejectedEndpoints = new Set<string>()
const identityCalls: string[] = []
const network = new Map<string, string>()
const transportCalls: string[] = []
const endpointPins = new Map<string, string>()
let discoveredEndpoints: string[] = []
let emitPreview: ((sessionId: string, payload: unknown) => void) | undefined
const published: Array<{ channel: string; data: unknown }> = []
let identityGate: Promise<void> | undefined
let clockOffset = 0
const now = Date.now
class FixtureCoreClient {
  private connected = true
  constructor(private readonly options: { baseUrl: string; identityPin?: string; reconnect?: boolean; onEvent?: (event: CoreAgentEvent) => void; onStatus?: (value: 'open' | 'closed') => void }) {}
  agent(event: CoreAgentEvent) { this.options.onEvent?.(event) }
  get reconnect() { return this.options.reconnect }
  disconnect() { this.connected = false; this.options.onStatus?.('closed') }
  get address() { return this.options.baseUrl }
  async identity(): Promise<{ coreId: string; version: string; protocolVersion: number; capabilities: string[]; platform: string; osId: string }> {
    await identityGate
    identityCalls.push(this.address)
    if (rejectedEndpoints.has(this.address)) throw new CoreClientError('unauthorized', { status: 401 })
    const pin = endpointPins.get(this.address)
    if (pin && pin !== this.options.identityPin) throw new Error('Core 身份不匹配')
    const coreId = network.get(this.address)
    if (!coreId) {
      clockOffset += 5_000
      throw new Error('不可达')
    }
    return { coreId, version: 'fixture', protocolVersion: 1, capabilities: ['agent.events.resume'], platform: 'linux', osId: 'ubuntu' }
  }
  addChatEventListener() { return () => {} }
  addSnapshotListener() { return () => {} }
  addPlanningEventListener() { return () => {} }
  async connect() { transportCalls.push(`connect:${this.address}`) }
  get isConnected() { return this.connected }
  startEventRecovery() { transportCalls.push(`refresh:${this.address}`) }
  async waitForHostIdle() { transportCalls.push(`idle:${this.address}`) }
  async probeLatency() { return 22 }
  close() { transportCalls.push(`close:${this.address}`); this.options.onStatus?.('closed') }
}
const originalPath = app.getPath
const originalStorage = safeStorage.isEncryptionAvailable
app.getPath = () => root
safeStorage.isEncryptionAvailable = () => true
mock.module('./core-client', () => ({ CoreClient: FixtureCoreClient, CoreClientError }))
mock.module('./core-discovery', () => ({ discoverPairedCore: async () => discoveredEndpoints.length ? { endpoints: discoveredEndpoints } : undefined }))
mock.module('./core-local-bridge', () => ({ attachLocalCoreClient: () => {}, detachLocalCoreClient: () => {} }))
mock.module('./core-host-connection', () => ({ configureCoreHostConnection: (_client: unknown, options: { emitPreview: typeof emitPreview }) => { emitPreview = options.emitPreview } }))
const { BrowserWindow } = await import('electron')
const originalWindows = BrowserWindow.getAllWindows
const previewWindow = new BrowserWindow({ show: false })
previewWindow.webContents.isDestroyed = () => false
previewWindow.webContents.send = (channel: string, data: unknown) => { published.push({ channel, data }) }
BrowserWindow.getAllWindows = () => [previewWindow]
mock.module('./chat-stream-bus', () => ({ pushChatStream: () => {} }))
const service = await import('./core-target-service')
const A = 'https://one.example.test'
const B = 'https://backup.example.test'
const C = 'https://other.example.test'

const input = (baseUrl: string) => ({ name: '工作机', baseUrl, token: 'fixture-only' })
afterAll(() => { BrowserWindow.getAllWindows = originalWindows; Date.now = now; app.getPath = originalPath; safeStorage.isEncryptionAvailable = originalStorage; rmSync(root, { recursive: true, force: true }) })

describe('远程内核生命周期', () => {
  test('启动重试超时保持原 Core 离线，用户主动选择后才回本机', async () => {
    writeFileSync(storePath, JSON.stringify({ currentId: 'one', targets: [{ id: 'one', name: '旧工作机', baseUrl: A, encryptedToken: 'Zml4dHVyZS1vbmx5', coreId: 'core-one' }] }))
    Date.now = () => now() + clockOffset
    const startup = service.activateSavedCoreTarget()
    expect(service.listCoreTargets()).toMatchObject({ currentId: 'one', startup: 'restoring' })
    await startup
    expect(service.listCoreTargets()).toMatchObject({ currentId: 'one', startup: 'offline' })
    expect(service.getActiveCoreClient()).toBeNull()
    expect(JSON.parse(readFileSync(storePath, 'utf8')).currentId).toBe('one')
    await service.selectCoreTarget('local')
    expect(JSON.parse(readFileSync(storePath, 'utf8')).preferredId).toBe('local')
    await service.removeCoreTarget('one')
    Date.now = now
  }, 6_000)

  test('验证保存不同地址归入同一张卡，另一身份不能覆盖，令牌不回显', async () => {
    network.set(A, 'core-one')
    network.set(B, 'core-one')
    const a = await service.addCoreTarget(input(A))
    const b = await service.addCoreTarget(input(B))
    expect(a).toMatchObject({ platform: 'linux', osId: 'ubuntu' })
    expect(b).toMatchObject({ platform: 'linux', osId: 'ubuntu' })
    expect(JSON.parse(readFileSync(storePath, 'utf8')).targets[0]).toMatchObject({ platform: 'linux', osId: 'ubuntu' })
    expect(a.id).toBe(b.id)
    expect(service.listCoreTargets().currentId).toBe('local')
    expect(b.endpoints?.map(e => e.baseUrl)).toEqual([A, B])
    expect(JSON.stringify(service.listCoreTargets())).not.toContain('fixture-only')
    network.set(C, 'core-other')
    await expect(service.saveCoreEndpoint(a.id, { endpointId: b.endpoints![1]!.id, baseUrl: C })).rejects.toThrow('这是另一台内核')
    expect(service.listCoreTargets().targets.find(target => target.id === a.id)?.endpoints).toEqual(b.endpoints)
  })

  test('新内核离线不换环境；同 Core 换线只交接连接，不改变路由世代', async () => {
    const one = service.listCoreTargets().targets.find(target => target.coreId === 'core-one')!
    const other = await service.addCoreTarget(input(C))
    await service.selectCoreTarget(one.id)
    const sessionId = service.namespaceCoreSessionId('preview-session', 'core-one')
    emitPreview?.(sessionId, { kind: 'profer_event', event: { type: 'file_preview' } })
    expect(published.at(-1)?.data).toMatchObject({ sessionId })
    const before = service.listCoreTargets()
    const old = service.getActiveCoreClient()
    network.delete(C)
    await expect(service.selectCoreTarget(other.id)).rejects.toThrow('不可达')
    expect(service.getActiveCoreClient()).toBe(old)
    expect(service.listCoreTargets()).toEqual(before)
    const line = one.endpoints![1]!
    const changed = await service.selectCoreEndpoint(one.id, line.id)
    expect(changed).toMatchObject({ currentId: one.id, generation: before.generation })
    expect(changed.targets.find(target => target.id === one.id)?.selectedEndpointId).toBe(line.id)
    expect(transportCalls.slice(-4)).toEqual([`connect:${B}`, `idle:${A}`, `refresh:${B}`, `close:${A}`])
    await service.selectCoreTarget('local')
  })

  test('配对保存身份与加密授权，地址变化经发现验证后接续同一目标', async () => {
    const pin = `sha256/${Buffer.alloc(32, 1).toString('base64')}`
    const first = 'https://paired.example.test'
    const moved = 'https://moved.example.test'
    network.set(first, 'paired-core')
    endpointPins.set(first, pin)
    const target = await service.savePairedCoreTarget({ name: 'Paired', coreId: 'paired-core', endpoints: [first], identityPin: pin, bindingId: 'binding', credential: 'paired-credential' })
    expect(service.listCoreTargets().currentId).toBe('local')
    const saved = JSON.parse(readFileSync(storePath, 'utf8')).targets.find((value: { coreId: string }) => value.coreId === 'paired-core')
    expect(saved.endpoints[0]).toMatchObject({ identityPin: pin, bindingId: 'binding' })
    expect(saved.endpoints[0].encryptedToken).not.toBe('paired-credential')
    expect(JSON.stringify(service.listCoreTargets())).not.toContain('paired-credential')
    await expect(service.savePairedCoreTarget({ name: 'Other', coreId: 'paired-core', endpoints: [first], identityPin: `sha256/${Buffer.alloc(32, 2).toString('base64')}`, bindingId: 'evil', credential: 'wrong' })).rejects.toThrow('不一致')
    network.delete(first)
    network.set(moved, 'paired-core')
    endpointPins.set(moved, pin)
    discoveredEndpoints = [moved]
    const connected = await service.selectCoreTarget(target.id)
    expect(connected.currentId).toBe(target.id)
    expect(connected.targets.find(value => value.id === target.id)?.baseUrl).toBe(moved)
    expect(connected.targets.find(value => value.id === target.id)?.coreId).toBe('paired-core')
    const client = service.getActiveCoreClient() as unknown as FixtureCoreClient
    expect(client.reconnect).toBe(false)
    rejectedEndpoints.add(moved)
    const calls = identityCalls.length
    client.disconnect()
    await Bun.sleep(6_200)
    expect(identityCalls.slice(calls)).toEqual([moved])
    expect(service.listCoreTargets().currentId).toBe(target.id)
    expect(service.listCoreTargets().targets.find(value => value.id === target.id)?.status).toBe('error')
    rejectedEndpoints.delete(moved)
    expect((await service.selectCoreTarget(target.id)).targets.find(value => value.id === target.id)?.status).toBe('connected')
    await service.selectCoreTarget('local')
    discoveredEndpoints = []
  }, 8_000)
})

test('本机摘要透传发行版 ID，旧 Core 缺省时仍兼容', () => {
  const client = new FixtureCoreClient({ baseUrl: 'http://local.test' })
  const identity = { protocolVersion: 1, coreId: 'local-core', version: 'fixture', capabilities: [], platform: 'linux', osId: 'debian' }
  service.setLocalCoreClient(client as unknown as Parameters<typeof service.setLocalCoreClient>[0], identity)
  expect(service.listCoreTargets().targets.find(target => target.kind === 'local')).toMatchObject({ platform: 'linux', osId: 'debian' })
  const { osId: _osId, ...legacyIdentity } = identity
  service.setLocalCoreClient(client as unknown as Parameters<typeof service.setLocalCoreClient>[0], legacyIdentity)
  expect(service.listCoreTargets().targets.find(target => target.kind === 'local')?.osId).toBeUndefined()
})

test('完整窗口的选择、并行 await、事件和关闭相互隔离，后台默认保持兼容', async () => {
  const { runCoreWindow, registerCoreWindow, unregisterCoreWindow } = await import('./core-window-scope')
  network.set(A, 'core-one')
  network.set(C, 'core-other')
  await service.selectCoreTarget('local')
  const one = service.listCoreTargets().targets.find(target => target.coreId === 'core-one')!
  const other = service.listCoreTargets().targets.find(target => target.coreId === 'core-other')!
  const second = new BrowserWindow({ show: false })
  second.webContents.isDestroyed = () => false
  const original = BrowserWindow.getAllWindows
  BrowserWindow.getAllWindows = () => [previewWindow, second]
  const received: string[] = []
  second.webContents.send = channel => { received.push(channel) }
  Object.defineProperty(second.webContents, "id", { value: 8032, configurable: true })
  const id = second.webContents.id
  registerCoreWindow(id)
  try {
    await service.initializeWindowCore(id)
    const localBefore = service.getActiveCoreClient()
    const [remote, local] = await Promise.all([
      runCoreWindow(id, async () => {
        await service.selectCoreTarget(one.id)
        const client = service.getActiveCoreClient()
        const generation = service.getCoreTargetGeneration()
        await Bun.sleep(10)
        expect(service.getActiveCoreClient()).toBe(client)
        expect(service.getCoreTargetGeneration()).toBe(generation)
        return service.getCurrentCoreTargetId()
      }),
      (async () => { await Bun.sleep(2); expect(service.getCurrentCoreTargetId()).toBe('local'); return service.getActiveCoreClient() })(),
    ])
    expect(remote).toBe(one.id)
    expect(local).toBe(localBefore)
    const before = received.length
    await service.selectCoreTarget(other.id)
    expect(received.length).toBe(before)
    expect(runCoreWindow(id, () => service.getCurrentCoreTargetId())).toBe(one.id)
    // 外部连接回调在默认调用栈触发，也不能串到默认上下文。
    const secondaryClient = runCoreWindow(id, () => service.getActiveCoreClient()) as unknown as FixtureCoreClient
    secondaryClient.disconnect()
    expect(runCoreWindow(id, () => service.listCoreTargets()).targets.find(value => value.id === one.id)?.status).toBe('error')
    expect(service.listCoreTargets().targets.find(value => value.id === other.id)?.status).toBe('connected')
    await runCoreWindow(id, () => service.selectCoreTarget('local'))
    expect(service.getCurrentCoreTargetId()).toBe(other.id)
    // 真实 IPC 注册入口必须把 scope 传进异步业务路由，而非只隔离状态查询。
    const { installCoreIpcScope } = await import('./core-ipc-scope')
    let handler: ((event: unknown) => unknown) | undefined
    const ipc = {
      handle: (_channel: string, listener: (event: unknown) => unknown) => { handler = listener },
      on: () => ipc,
    }
    installCoreIpcScope(ipc as unknown as Parameters<typeof installCoreIpcScope>[0])
    ipc.handle('test:core-window-route', async () => {
      await Bun.sleep(1)
      return service.getCurrentCoreTargetId()
    })
    expect(await handler!({ sender: second.webContents })).toBe('local')
    expect(await handler!({ sender: { id: -999 } })).toBe(other.id)
    const stale = runCoreWindow(id, async () => {
      await Bun.sleep(2)
      return service.getCurrentCoreTargetId()
    })
    const background = service.getActiveCoreClient()
    service.disposeWindowCore(id)
    await expect(stale).rejects.toThrow('Core 窗口已关闭')
    expect(service.getActiveCoreClient()).toBe(background)
    expect(service.getCurrentCoreTargetId()).toBe(other.id)
    expect(received).toContain('core-target:changed')
  } finally {
    service.disposeWindowCore(id)
    unregisterCoreWindow(id)
    BrowserWindow.getAllWindows = original
    await service.selectCoreTarget('local')
  }
})


test('延迟远端握手不阻塞 Renderer 加载，首份快照已继承目标', async () => {
  const { runCoreWindow } = await import('./core-window-scope')
  network.set(A, 'core-one')
  const target = service.listCoreTargets().targets.find(value => value.coreId === 'core-one')!
  await service.selectCoreTarget(target.id)
  let release!: () => void
  identityGate = new Promise<void>(resolve => { release = resolve })
  const id = 8040
  let settled = false
  const coreReady = service.initializeWindowCore(id).finally(() => { settled = true })
  try {
    expect(runCoreWindow(id, service.listCoreTargets)).toMatchObject({ currentId: target.id, startup: 'restoring' })
    expect(runCoreWindow(id, service.getActiveCoreClient)).toBeNull()
    // 执行生产建窗函数最后的加载片段，不靠计时阈值推断并行。
    const source = readFileSync(new URL('./main-app-windows.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  void coreReady.then')
    const end = source.indexOf('  console.log(`[窗口] 已创建会话窗口', start)
    expect(start).toBeGreaterThan(0)
    let loaded = false
    new Function('coreReady', 'record', 'win', 'loadRenderer', 'logWindowPhase', 'handoffId', source.slice(start, end))(
      coreReady, { completeBootstrap: () => {} }, {}, () => { loaded = true }, () => {}, "test",
    )
    await Bun.sleep(2)
    expect(loaded).toBe(true)
    expect(settled).toBe(false)
    release()
    await coreReady
    expect(runCoreWindow(id, service.listCoreTargets)).toMatchObject({ currentId: target.id, startup: undefined })
    expect(runCoreWindow(id, service.getActiveCoreClient)).not.toBe(service.getActiveCoreClient())
  } finally {
    release(); identityGate = undefined
    await coreReady.catch(() => {})
    service.disposeWindowCore(id)
    await service.selectCoreTarget('local')
  }
})


test('同远端 Core 的独立连接只提示本人窗口、仅一个流接收者；本机及退役连接不收到活动或完成', async () => {
  const { runCoreWindow } = await import('./core-window-scope')
  const { sessionWebContents } = await import('./agent-window-delivery')
  const original = BrowserWindow.getAllWindows
  const make = (id: number) => {
    const frames: Array<[string, unknown]> = []
    const win = { isDestroyed: () => false, webContents: { id, isDestroyed: () => false, send: (channel: string, value: unknown) => frames.push([channel, value]) } } as unknown as import('electron').BrowserWindow
    return { id, frames, win }
  }
  const primary = make(8050), owner = make(8051), local = make(8052), extra = make(8053)
  const all = [primary, owner, local, extra]
  BrowserWindow.getAllWindows = () => all.map(w => w.win)
  const remote = service.listCoreTargets().targets.find(t => t.coreId === 'core-one')!
  const id = service.namespaceCoreSessionId('same', 'core-one')
  try {
    await service.initializeWindowCore(primary.id, undefined, true)
    await service.selectCoreTarget(remote.id)
    await service.initializeWindowCore(owner.id, primary.id)
    await service.initializeWindowCore(local.id, primary.id)
    await runCoreWindow(local.id, () => service.selectCoreTarget('local'))
    sessionWebContents.set(id, owner.win.webContents)
    all.forEach(w => w.frames.length = 0)
    const client = service.getActiveCoreClient() as unknown as FixtureCoreClient
    const second = runCoreWindow(owner.id, service.getActiveCoreClient) as unknown as FixtureCoreClient
    for (const c of [client, second]) {
      c.agent({ kind: 'agent_event', sessionId: 'same', payload: { kind: 'profer_event', event: { type: 'runtime_started' } } })
      c.agent({ kind: 'agent_event', sessionId: 'same', payload: { kind: 'sdk_message', message: { text: 'token' } } })
      c.agent({ kind: 'agent_event', sessionId: 'same', payload: { kind: 'profer_event', event: { type: 'run_completed' } } })
    }
    expect(primary.frames).toEqual(Array(2).fill([C_CHANNEL.SESSION_ACTIVITY_INVALIDATED, { sessionId: id }]))
    expect(owner.frames.filter(([c]) => c === C_CHANNEL.STREAM_COMPLETE)).toHaveLength(1)
    expect(owner.frames.filter(([c]) => c === C_CHANNEL.STREAM_EVENT)).toHaveLength(3)
    expect(local.frames).toBeEmpty(); expect(extra.frames).toBeEmpty()
    const final = { kind: 'agent_event', sessionId: 'same', eventId: 'epoch:99', payload: { kind: 'profer_event', event: { type: 'run_completed' } } }
    second.agent(final)
    sessionWebContents.set(id, primary.win.webContents)
    client.agent(final) // 同一个网络帧晚于移窗；新 owner 不应再发通知或标记完成。
    expect(primary.frames.filter(([c]) => c === C_CHANNEL.STREAM_COMPLETE)).toBeEmpty()
    await runCoreWindow(owner.id, () => service.selectCoreTarget('local'))
    owner.frames.length = 0
    second.agent({ kind: 'agent_event', sessionId: 'same', payload: { kind: 'profer_event', event: { type: 'run_completed' } } })
    expect(owner.frames).toBeEmpty()
  } finally {
    sessionWebContents.delete(id)
    all.forEach(w => service.disposeWindowCore(w.id))
    BrowserWindow.getAllWindows = original
    await service.selectCoreTarget('local')
  }
})
