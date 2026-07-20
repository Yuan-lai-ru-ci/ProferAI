import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { listChannelsWithBackgroundSync } from './local-first-channel-listing'

const localChannels: Channel[] = [{
  id: 'local-channel',
  name: '本地渠道',
  provider: 'custom',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'encrypted',
  models: [{ id: 'local-model', name: '本地模型', enabled: true }],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
}]

describe('listChannelsWithBackgroundSync', () => {
  test('returns the local channel snapshot without waiting for a pending commercial sync', async () => {
    let releaseSync: (() => void) | undefined
    const pendingSync = new Promise<void>((resolve) => { releaseSync = resolve })
    let syncStarted = false

    const channels = listChannelsWithBackgroundSync({
      listLocalChannels: () => localChannels,
      isCommercialMode: () => true,
      getTeamAuthWithRefresh: async () => ({ baseUrl: 'https://server.example', token: 'token' }),
      syncChannelsFromServer: async () => {
        syncStarted = true
        await pendingSync
      },
      onSyncFailure: () => {},
    })

    expect(channels).toBe(localChannels)
    await Promise.resolve()
    expect(syncStarted).toBeTrue()
    releaseSync?.()
  })

  test('keeps the local snapshot available when background authentication or sync fails', async () => {
    const failures: unknown[] = []

    const channels = listChannelsWithBackgroundSync({
      listLocalChannels: () => localChannels,
      isCommercialMode: () => true,
      getTeamAuthWithRefresh: async () => {
        throw new Error('服务器不可达')
      },
      syncChannelsFromServer: async () => {},
      onSyncFailure: (error) => failures.push(error),
    })

    expect(channels).toBe(localChannels)
    await Promise.resolve()
    await Promise.resolve()
    expect(failures).toHaveLength(1)
  })

  test('does not start authentication refresh outside commercial mode', async () => {
    let authRequested = false

    const channels = listChannelsWithBackgroundSync({
      listLocalChannels: () => localChannels,
      isCommercialMode: () => false,
      getTeamAuthWithRefresh: async () => {
        authRequested = true
        return null
      },
      syncChannelsFromServer: async () => {},
      onSyncFailure: () => {},
    })

    expect(channels).toBe(localChannels)
    await Promise.resolve()
    expect(authRequested).toBeFalse()
  })
})
