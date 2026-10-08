import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { listChannelsWithBackgroundSync, type LocalFirstChannelListingDeps } from './local-first-channel-listing'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

describe('后台目录同步代际', () => {
  test('Given 登出进行中 When LIST Then 只读本地、不续期也不启动同步', async () => {
    let calls = 0
    expect(listChannelsWithBackgroundSync({
      listLocalChannels: () => localChannels, isCommercialMode: () => true,
      getSessionGeneration: () => null, getTeamAuth: () => null,
      getTeamAuthWithRefresh: async () => { calls += 1; return null },
      syncChannelsFromServer: async () => { calls += 1 }, onSyncFailure() {},
    })).toBe(localChannels)
    await settle()
    expect(calls).toBe(0)
  })

  test('Given 多次 LIST When 同代同步完成 Then 仅同步一次，localOnly 不再启动同步', async () => {
    const pending = deferred<void>()
    const auth = { baseUrl: 'https://fixture.invalid', teamAccountId: 'a', token: 'fixture' }
    let calls = 0
    const deps: LocalFirstChannelListingDeps = {
      listLocalChannels: () => localChannels, isCommercialMode: () => true,
      getSessionGeneration: () => 1, getTeamAuth: () => auth, getTeamAuthWithRefresh: async () => auth,
      syncChannelsFromServer: async () => { calls += 1; await pending.promise },
      onSyncFailure() {},
    }
    expect(listChannelsWithBackgroundSync(deps)).toBe(localChannels)
    listChannelsWithBackgroundSync(deps)
    await settle()
    expect(calls).toBe(1)
    pending.resolve()
    await settle()
    listChannelsWithBackgroundSync(deps, false)
    await settle()
    expect(calls).toBe(1)
    listChannelsWithBackgroundSync(deps)
    await settle()
    expect(calls).toBe(2)
  })

  test('Given auth refresh 在飞行中 When 登出后同账号重登 Then 旧代际不发起同步', async () => {
    const auth = { baseUrl: 'https://fixture.invalid', teamAccountId: 'a', token: 'fixture' }
    const pending = deferred<typeof auth>()
    let generation = 1
    let calls = 0
    const deps: LocalFirstChannelListingDeps = {
      listLocalChannels: () => localChannels, isCommercialMode: () => true,
      getSessionGeneration: () => generation, getTeamAuth: () => auth, getTeamAuthWithRefresh: () => pending.promise,
      syncChannelsFromServer: async () => { calls += 1 }, onSyncFailure() {},
    }
    listChannelsWithBackgroundSync(deps)
    generation += 1
    pending.resolve(auth)
    await settle()
    expect(calls).toBe(0)
  })

  test('Given auth refresh 在飞行中 When 切账号 Then 不用旧账号身份发起同步', async () => {
    let auth = { baseUrl: 'https://fixture.invalid', teamAccountId: 'a', token: 'fixture' }
    const pending = deferred<typeof auth>()
    let calls = 0
    const deps: LocalFirstChannelListingDeps = {
      listLocalChannels: () => localChannels, isCommercialMode: () => true,
      getSessionGeneration: () => 1, getTeamAuth: () => auth, getTeamAuthWithRefresh: () => pending.promise,
      syncChannelsFromServer: async () => { calls += 1 }, onSyncFailure() {},
    }
    listChannelsWithBackgroundSync(deps)
    auth = { ...auth, teamAccountId: 'b' }
    pending.resolve(auth)
    await settle()
    expect(calls).toBe(0)
  })
})
describe('listChannelsWithBackgroundSync', () => {
  test('returns the local channel snapshot without waiting for a pending commercial sync', async () => {
    let releaseSync: (() => void) | undefined
    const pendingSync = new Promise<void>((resolve) => { releaseSync = resolve })
    let syncStarted = false

    const channels = listChannelsWithBackgroundSync({
      listLocalChannels: () => localChannels,
      isCommercialMode: () => true,
      getSessionGeneration: () => 1,
      getTeamAuth: () => ({ baseUrl: 'https://server.example', token: 'token', teamAccountId: 'fixture' }),
      getTeamAuthWithRefresh: async () => ({ baseUrl: 'https://server.example', token: 'token', teamAccountId: 'fixture' }),
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
      getSessionGeneration: () => 1,
      getTeamAuth: () => null,
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
      getSessionGeneration: () => 1,
      getTeamAuth: () => null,
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
