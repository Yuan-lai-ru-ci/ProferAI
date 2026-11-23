import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CORE_CONNECTION_IPC_CHANNELS } from '../../types/core-connection'

const source = readFileSync(new URL('./core-target-ipc.ts', import.meta.url), 'utf8')
const start = source.indexOf('  ipcMain.handle(CORE_CONNECTION_IPC_CHANNELS.STATE')
const end = source.indexOf('  ipcMain.handle(CORE_TARGET_IPC_CHANNELS.LIST', start)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

describe('Core connection IPC contract', () => {
  test('every management operation validates the sender before accessing credentials or storage', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const calls: unknown[][] = []
    let allowed = false
    const services = Object.fromEntries(['getCoreConnectionState', 'retryLocalCoreConnection', 'setCoreSharing', 'createCoreInvitation', 'pairCoreInvitation', 'pairAndSelectCoreInvitation', 'revokeCoreBinding'].map(name => [name, (...args: unknown[]) => { calls.push([name, ...args]); return name }]))
    const deps = {
      ...services, CORE_CONNECTION_IPC_CHANNELS,
      ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
      authorize: () => { if (!allowed) throw new Error('unauthorized') },
    }
    new Function(...Object.keys(deps), script)(...Object.values(deps))
    expect(handlers.size).toBe(7)
    expect(handlers.has('core-connection:enable-local')).toBe(false)
    for (const handler of handlers.values()) expect(() => handler({ sender: 'untrusted' }, 'payload')).toThrow('unauthorized')
    expect(calls).toEqual([])
    allowed = true
    handlers.get(CORE_CONNECTION_IPC_CHANNELS.SET_SHARING)!({}, true)
    handlers.get(CORE_CONNECTION_IPC_CHANNELS.PAIR)!({}, 'isolated-invitation', 'https://127.0.0.1:17788')
    handlers.get(CORE_CONNECTION_IPC_CHANNELS.REVOKE)!({}, 'device-id')
    handlers.get(CORE_CONNECTION_IPC_CHANNELS.INVITE)!({}, 1800, 900)
    handlers.get(CORE_CONNECTION_IPC_CHANNELS.PAIR_AND_SELECT)!({}, 'new-invitation', 'https://127.0.0.1:17789')
    expect(calls).toEqual([['setCoreSharing', true], ['pairCoreInvitation', 'isolated-invitation', 'https://127.0.0.1:17788'], ['revokeCoreBinding', 'device-id'], ['createCoreInvitation', 1800, 900], ['pairAndSelectCoreInvitation', 'new-invitation', 'https://127.0.0.1:17789']])
  })
})
