import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS } from '@profer/shared'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./core-target-service.ts', import.meta.url), 'utf8')
const start = source.indexOf('function clientFor(')
const end = source.indexOf('\nfunction summaries(', start)
if (start < 0 || end < start) throw new Error('Core client factory boundary missing')
const factory = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

type Status = 'connecting' | 'open' | 'closed' | 'error'
class FixtureClient {
  constructor(readonly options: { onStatus: (status: Status) => void; onWorkspaceEvent: () => void }) {}
  emit(status: Status): void { this.options.onStatus(status) }
  workspace(): void { this.options.onWorkspaceEvent() }
}

function harness() {
  let currentId = 'remote'
  let publications = 0
  const channels: string[] = []
  const create = new Function('CoreClient', 'decryptToken', 'readStore', 'publishSnapshot', 'BrowserWindow', 'AGENT_IPC_CHANNELS', 'AUTOMATION_IPC_CHANNELS', `
    let activeClient = null;
    let targetStatus = 'disconnected';
    ${factory}
    return {
      clientFor,
      activate(client) { activeClient = client; targetStatus = 'connected'; },
      status() { return targetStatus; }
    };
  `)
  const fixture = create(FixtureClient, () => 'fixture-token', () => ({ currentId }), () => { publications++ },
    { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string) => channels.push(channel) } }] }, AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS) as {
    clientFor(target: { id: string; baseUrl: string; encryptedToken: string }): FixtureClient
    activate(client: FixtureClient | null): void
    status(): string
  }
  return { ...fixture, setTarget: (id: string) => { currentId = id }, publications: () => publications, channels }
}
const target = { id: 'remote', coreId: 'owner-core', baseUrl: 'http://127.0.0.1:17792', encryptedToken: 'fixture' }

describe('Core target connection status ownership', () => {
  test('late events from a retired connection cannot overwrite its replacement for the same target', () => {
    const h = harness()
    const retired = h.clientFor(target)
    h.activate(retired)
    const replacement = h.clientFor(target)
    h.activate(replacement)
    retired.emit('closed')
    retired.emit('error')
    retired.emit('connecting')
    expect(h.status()).toBe('connected')
    expect(h.publications()).toBe(0)
    replacement.emit('closed')
    expect(h.status()).toBe('error')
    replacement.emit('open')
    expect(h.status()).toBe('connected')
    expect(h.publications()).toBe(2)
  })

  test('工作区刷新只允许当前已提交Core，替换连接/切Core后旧通知不发布', () => {
    const h = harness()
    const retired = h.clientFor(target)
    h.activate(retired)
    const active = h.clientFor(target)
    h.activate(active)
    retired.workspace()
    expect(h.channels).toEqual([])
    active.workspace()
    expect(h.channels).toEqual([AGENT_IPC_CHANNELS.WORKSPACES_CHANGED])
    h.setTarget('local')
    active.workspace()
    expect(h.channels).toHaveLength(1)
    h.setTarget('remote')
    active.emit('open')
    expect(h.channels).toEqual([AGENT_IPC_CHANNELS.WORKSPACES_CHANGED, AUTOMATION_IPC_CHANNELS.CHANGED, AGENT_IPC_CHANNELS.WORKSPACES_CHANGED])
  })

  test('unselected and not-yet-committed clients cannot publish state for the active target', () => {
    const h = harness()
    const active = h.clientFor(target)
    h.activate(active)
    const candidate = h.clientFor(target)
    candidate.emit('open')
    candidate.emit('closed')
    expect(h.publications()).toBe(0)
    h.setTarget('local')
    active.emit('error')
    expect(h.status()).toBe('connected')
    expect(h.publications()).toBe(0)
  })
})
