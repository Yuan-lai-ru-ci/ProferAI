import { afterAll, describe, expect, mock, test } from 'bun:test'
import { app, safeStorage } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'profer-core-target-lifecycle-'))
const storePath = join(root, 'core-targets.json')
const network = new Map<string, string>()
const transportCalls: string[] = []
let clockOffset = 0
const now = Date.now
class FixtureCoreClient {
  constructor(private readonly options: { baseUrl: string; onStatus?: (value: 'open' | 'closed') => void }) {}
  get address() { return this.options.baseUrl }
  async identity(): Promise<{ coreId: string; version: string; protocolVersion: number; capabilities: string[] }> {
    const coreId = network.get(this.address)
    if (!coreId) {
      clockOffset += 5_000
      throw new Error('不可达')
    }
    return { coreId, version: 'fixture', protocolVersion: 1, capabilities: ['agent.events.resume'] }
  }
  async connect() { transportCalls.push(`connect:${this.address}`) }
  get isConnected() { return true }
  startEventRecovery() { transportCalls.push(`refresh:${this.address}`) }
  async waitForHostIdle() { transportCalls.push(`idle:${this.address}`) }
  async probeLatency() { return 22 }
  close() { transportCalls.push(`close:${this.address}`); this.options.onStatus?.('closed') }
}
const originalPath = app.getPath
const originalStorage = safeStorage.isEncryptionAvailable
app.getPath = () => root
safeStorage.isEncryptionAvailable = () => true
mock.module('./core-client', () => ({ CoreClient: FixtureCoreClient }))
mock.module('./core-local-bridge', () => ({ attachLocalCoreClient: () => {}, detachLocalCoreClient: () => {} }))
mock.module('./core-host-connection', () => ({ configureCoreHostConnection: () => {} }))
mock.module('./chat-stream-bus', () => ({ pushChatStream: () => {} }))
const service = await import('./core-target-service')
const A = 'https://one.example.test'
const B = 'https://backup.example.test'
const C = 'https://other.example.test'

const input = (baseUrl: string) => ({ name: '工作机', baseUrl, token: 'fixture-only' })
afterAll(() => { Date.now = now; app.getPath = originalPath; safeStorage.isEncryptionAvailable = originalStorage; rmSync(root, { recursive: true, force: true }) })

describe('远程内核生命周期', () => {
  test('启动重试跨过总时限后回本机，仍保留上次远程偏好直到用户主动选本机', async () => {
    writeFileSync(storePath, JSON.stringify({ currentId: 'one', targets: [{ id: 'one', name: '旧工作机', baseUrl: A, encryptedToken: 'Zml4dHVyZS1vbmx5', coreId: 'core-one' }] }))
    Date.now = () => now() + clockOffset
    const startup = service.activateSavedCoreTarget()
    expect(service.listCoreTargets()).toMatchObject({ currentId: 'one', startup: 'restoring' })
    await startup
    expect(service.listCoreTargets()).toMatchObject({ currentId: 'local', startup: 'fallback' })
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
})
