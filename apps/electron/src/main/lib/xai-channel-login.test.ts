import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { XaiOAuthCredentials, XaiOAuthLoginInput } from '@profer/shared'

let commercial = false
let allowed = true
let calls = 0
let authorize: () => Promise<XaiOAuthCredentials>
const credentials: XaiOAuthCredentials = { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000,  }
mock.module('./auth-service', () => ({ getCommercialMode: () => commercial, isSelfConfigAllowed: () => allowed }))
mock.module('./token-crypto', () => ({
  encryptToken: (secret: string) => Buffer.from(secret).toString('base64'),
  decryptToken: (secret: string) => Buffer.from(secret, 'base64').toString(),
}))
mock.module('./codex-oauth-service', () => ({ loginCodexOAuth: async () => { throw new Error('禁止真实 OAuth') }, refreshCodexOAuth: async () => { throw new Error('禁止真实 OAuth') } }))
mock.module('./xai-oauth-service', () => ({
  loginXaiOAuth: () => { calls += 1; return authorize() },
  refreshXaiOAuth: async () => credentials,
}))
const { createChannel, decryptApiKey, deleteChannel, getChannelById, listChannels, loginXaiChannel, updateChannel } = await import('./channel-manager')
const originalDir = process.env.PROFER_CONFIG_DIR
let configDir: string
const input: Exclude<XaiOAuthLoginInput, string> = {
  name: 'Fixture xAI', baseUrl: 'https://fixture.invalid/v1', enabled: true, agentRuntimes: ['pi'],
  models: [{ id: 'gpt-6-astra', name: 'Fixture Astra', enabled: true }],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'profer-xai-login-'))
  process.env.PROFER_CONFIG_DIR = configDir
  commercial = false; allowed = true; calls = 0
  authorize = async () => credentials
})
afterEach(() => {
  if (originalDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('Xai 主进程授权后创建（fixture OAuth/加密/配置目录）', () => {
  test('授权进行时无落盘，成功后只创建一个密文渠道', async () => {
    const pending = deferred<XaiOAuthCredentials>()
    authorize = () => pending.promise
    const first = loginXaiChannel(input)
    expect(existsSync(join(configDir, 'channels.json'))).toBe(false)
    await expect(loginXaiChannel(input)).rejects.toThrow('正在进行')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(calls).toBe(1)
    pending.resolve(credentials)
    const channel = await first
    expect(listChannels()).toHaveLength(1)
    expect(channel.provider).toBe('xai')
    expect(JSON.parse(decryptApiKey(channel.id))).toEqual(credentials)
    expect(readFileSync(join(configDir, 'channels.json'), 'utf8')).not.toContain(credentials.refresh)
  })

  for (const reason of ['fixture-cancelled', 'fixture-failed']) {
    test(`${reason} 不产生孤儿渠道，重试成功只有一个渠道`, async () => {
      authorize = async () => { throw new Error(reason) }
      await expect(loginXaiChannel(input)).rejects.toThrow(reason)
      expect(listChannels()).toEqual([])
      expect(existsSync(join(configDir, 'channels.json'))).toBe(false)
      authorize = async () => credentials
      await loginXaiChannel(input)
      expect(listChannels()).toHaveLength(1)
      expect(calls).toBe(2)
    })
  }

  test('已有 Xai 重新授权原位更新，失败不改变旧凭据', async () => {
    const channel = createChannel({ ...input, provider: 'xai', credentialMode: 'oauth', apiKey: JSON.stringify({ ...credentials }) })
    authorize = async () => { throw new Error('fixture-denied') }
    await expect(loginXaiChannel(channel.id)).rejects.toThrow('fixture-denied')
    expect(JSON.parse(decryptApiKey(channel.id)).refresh).toBe(credentials.refresh)
    authorize = async () => credentials
    expect((await loginXaiChannel(channel.id)).id).toBe(channel.id)
    expect(listChannels()).toHaveLength(1)
    expect(JSON.parse(decryptApiKey(channel.id))).toEqual(credentials)
  })

  test('商业模式无自配权限、非 Xai/官方渠道与空模型在 OAuth 前拒绝', async () => {
    commercial = true; allowed = false
    await expect(loginXaiChannel(input)).rejects.toThrow('商业模式')
    commercial = false
    await expect(loginXaiChannel({ ...input, models: [] })).rejects.toThrow('至少启用')
    await expect(loginXaiChannel('missing-fixture')).rejects.toThrow('不存在')
    const channel = createChannel({ ...input, provider: 'custom', apiKey: 'fixture-key' })
    await expect(loginXaiChannel(channel.id)).rejects.toThrow('不可重新授权')
    expect(calls).toBe(0)
  })

  test('授权期间渠道被删或换供应商，完成后拒绝写入', async () => {
    for (const remove of [true, false]) {
      const channel = createChannel({ ...input, provider: 'xai', credentialMode: 'oauth', apiKey: JSON.stringify(credentials) })
      const pending = deferred<XaiOAuthCredentials>()
      authorize = () => pending.promise
      const operation = loginXaiChannel(channel.id)
      if (remove) deleteChannel(channel.id)
      else updateChannel(channel.id, { provider: 'custom', apiKey: 'fixture-replaced-key' })
      pending.resolve(credentials)
      await expect(operation).rejects.toThrow('已删除或类型改变')
      if (!remove) {
        expect(getChannelById(channel.id)?.provider).toBe('custom')
        expect(decryptApiKey(channel.id)).toBe('fixture-replaced-key')
      }
    }
  })
})
