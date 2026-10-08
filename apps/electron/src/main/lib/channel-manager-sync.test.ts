import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel } from '@profer/shared'

let generation = 1
let auth: { baseUrl: string; teamAccountId: string; token: string } | null
let respond: () => Promise<Response>
let calls = 0
const invalidations: string[] = []
mock.module('./agent-service', () => ({ agentCatalogInvalidationPublisher: { invalidate: (catalog: string) => invalidations.push(catalog) } }))
mock.module('./auth-service', () => ({ getTeamAuth: () => auth, getAuthSessionGeneration: () => generation }))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./proxy-fetch', () => ({ getFetchFn: () => async () => { calls += 1; return respond() } }))
mock.module('./identity-service', () => ({ getOrCreateDeviceIdentity: () => ({ deviceId: 'fixture-sync-device' }) }))
mock.module('./settings-service', () => ({ getSettings: () => ({ agentChannelIds: ['fixture-local'] }), updateSettings: () => {} }))
mock.module('./codex-oauth-service', () => ({ loginCodexOAuth: async () => { throw new Error('禁止真实OAuth') }, refreshCodexOAuth: async () => { throw new Error('禁止真实OAuth') } }))
const { syncChannelsFromServer } = await import('./channel-manager')
const { encryptToken } = await import('./token-crypto')
const original = process.env.PROFER_CONFIG_DIR
let dir: string
let path: string
let bytes: string
const serverUrl = 'https://fixture.invalid'
const payload = { commercialMode: true, channels: [{ id: 'newapi-fixture', name: 'Fixture official', provider: 'openai',
  baseUrl: serverUrl, apiKey: 'fixture-server-secret', models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }] }] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'profer-channel-sync-'))
  process.env.PROFER_CONFIG_DIR = dir
  path = join(dir, 'channels.json')
  generation = 1; calls = 0
  invalidations.length = 0
  auth = { baseUrl: serverUrl, teamAccountId: 'a', token: 'fixture-a' }
  const local: Channel = { id: 'fixture-local', name: 'Fixture local', provider: 'custom', baseUrl: serverUrl,
    apiKey: encryptToken('fixture-local-secret'), models: [{ id: 'local', name: 'Local', enabled: true }],
    enabled: true, agentRuntimes: ['pi'], createdAt: 1, updatedAt: 1 }
  bytes = JSON.stringify({ version: 1, channels: [local], appliedPresetModelUpdates: ['glm-5.3-candidates-v1'] })
  writeFileSync(path, bytes)
  respond = async () => Response.json(payload)
})
afterEach(() => {
  if (original === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = original
  rmSync(dir, { recursive: true, force: true })
})
describe('服务端渠道同步：写盘代际', () => {
  test('Given 当前账号 When 同步成功 Then 保留本地及官方模型偏好、仅落密文', async () => {
    expect(await syncChannelsFromServer(serverUrl, 'fixture-a')).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { channels: Channel[] }
    expect(saved.channels.map((channel) => channel.id)).toEqual(['fixture-local', 'newapi-fixture'])
    saved.channels[1]!.enabled = false
    saved.channels[1]!.models[0]!.enabled = false
    saved.channels[1]!.models[0]!.context1m = true
    writeFileSync(path, JSON.stringify(saved))
    await syncChannelsFromServer(serverUrl, 'fixture-a')
    const again = JSON.parse(readFileSync(path, 'utf8')) as { channels: Channel[] }
    expect(again.channels[1]).toMatchObject({ enabled: false, models: [{ enabled: false, context1m: true }] })
    expect(readFileSync(path, 'utf8')).not.toContain('fixture-server-secret')
    expect(invalidations).toEqual(['channels', 'channels'])
  })
  test('Given 旧token或失效账号 When 发起 Then 不访问网络也不改配置', async () => {
    await expect(syncChannelsFromServer(serverUrl, 'old-token')).rejects.toThrow('失效')
    auth = null
    await expect(syncChannelsFromServer(serverUrl, 'fixture-a')).rejects.toThrow('失效')
    expect(calls).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
  test('Given 网络请求在飞行中 When 跨账号/失效/同账号重登/续期 Then 旧响应不得落盘或覆盖备份', async () => {
    for (const change of ['account', 'logout', 'generation', 'token']) {
      auth = { baseUrl: serverUrl, teamAccountId: 'a', token: 'fixture-a' }
      const pending = deferred<Response>()
      respond = () => pending.promise
      const operation = syncChannelsFromServer(serverUrl, 'fixture-a')
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
      if (change === 'account') auth = { ...auth, teamAccountId: 'b' }
      if (change === 'logout') auth = null
      if (change === 'generation') generation += 1
      if (change === 'token' && auth) auth = { ...auth, token: 'fixture-renewed' }
      pending.resolve(Response.json(payload))
      await expect(operation).rejects.toThrow('会话已变化')
      expect(readFileSync(path, 'utf8')).toBe(bytes)
      expect(existsSync(path + '.server-backup')).toBe(false)
      expect(invalidations).toEqual([])
    }
  })
  test('Given 空目录或非商业响应 When 同步 Then 明确未写入且保留缓存', async () => {
    respond = async () => Response.json({ commercialMode: true, channels: [] })
    expect(await syncChannelsFromServer(serverUrl, 'fixture-a')).toBe(false)
    respond = async () => Response.json({ commercialMode: false, channels: [] })
    expect(await syncChannelsFromServer(serverUrl, 'fixture-a')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(invalidations).toEqual([])
  })
})
