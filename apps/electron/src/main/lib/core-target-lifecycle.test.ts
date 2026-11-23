import { afterAll, describe, expect, mock, test } from 'bun:test'
import { app, safeStorage } from 'electron'
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
let clockOffset = 0
const now = Date.now
class FixtureCoreClient {
  private connected = true
  constructor(private readonly options: { baseUrl: string; identityPin?: string; reconnect?: boolean; onStatus?: (value: 'open' | 'closed') => void }) {}
  get reconnect() { return this.options.reconnect }
  disconnect() { this.connected = false; this.options.onStatus?.('closed') }
  get address() { return this.options.baseUrl }
  async identity(): Promise<{ coreId: string; version: string; protocolVersion: number; capabilities: string[]; platform: string; osId: string }> {
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
