import { test, expect } from 'bun:test'
import { CoreDiscoveryPublisher } from './connection-discovery'
import { discoverPairedCore } from '../../electron/src/main/lib/core-discovery'
import type { CoreConnectionState } from '@profer/shared'

test('真实多播支持两个客户端、发布者重启后发现新地址、拒绝不匹配pin', async () => {
  const state: CoreConnectionState = { coreId: 'discovery-fixture', name: 'fixture', sharingEnabled: true, port: 12345, endpoints: ['https://127.0.0.1:12345'], bindings: [], pin: { algorithm: 'spki-sha256', value: `sha256/${'A'.repeat(43)}=` } }
  let publisher = new CoreDiscoveryPublisher(() => state)
  try {
    await publisher.start()
    const clients = await Promise.all([discoverPairedCore({ coreId: state.coreId, pin: state.pin }), discoverPairedCore({ coreId: state.coreId, pin: state.pin })])
    expect(clients.map(client => client?.endpoints)).toEqual([state.endpoints, state.endpoints])
    publisher.close()
    state.endpoints = ['https://127.0.0.2:12345']
    publisher = new CoreDiscoveryPublisher(() => state); await publisher.start()
    expect((await discoverPairedCore({ coreId: state.coreId, pin: state.pin }))?.endpoints).toEqual(state.endpoints)
    expect(await discoverPairedCore({ coreId: state.coreId, pin: { algorithm: 'spki-sha256', value: 'wrong' }, timeoutMs: 100 })).toBeUndefined()
  } finally { publisher.close() }
})
