import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ChannelCreateInput, ChannelsConfig, CodexOAuthCredentials } from '@profer/shared'

let identityFails = false
let commercial = false
let selfConfig = true
let refreshCalls = 0
const requests: RequestInit[] = []
mock.module('./identity-service', () => ({
  getOrCreateDeviceIdentity: () => {
    if (identityFails) throw new Error('fixture identity failure')
    return { deviceId: 'fixture-storage-device' }
  },
}))
mock.module('./auth-service', () => ({
  getCommercialMode: () => commercial,
  isSelfConfigAllowed: () => selfConfig,
}))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./proxy-fetch', () => ({
  getFetchFn: () => async (_url: string, init: RequestInit) => {
    requests.push(init)
    return new Response(JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18000 },
    } }), { status: 200 })
  },
}))
mock.module('./codex-oauth-service', () => ({
  loginCodexOAuth: async () => { throw new Error('禁止真实 OAuth') },
  refreshCodexOAuth: async () => {
    refreshCalls += 1
    return { access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: Date.now() + 3600000 }
  },
}))
const {
  backupChannelsForAccount, createChannel, decryptApiKey, deleteChannel, getChannelById,
  getChannelPlanQuota, listChannels, persistXaiOAuthCredentials, restoreChannelsForAccount, updateChannel,
} = await import('./channel-manager')
const { encryptToken } = await import('./token-crypto')

const originalConfigDir = process.env.PROFER_CONFIG_DIR
let configDir: string
let channelsPath: string
function fixtureChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'fixture-channel', name: 'Fixture', provider: 'custom', baseUrl: 'https://fixture.invalid/v1',
    apiKey: encryptToken('sk-fixture-secret'), models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }],
    enabled: true, agentRuntimes: ['pi'], createdAt: 1, updatedAt: 1, ...overrides,
  }
}
function writeConfig(channels: Channel[]): void {
  const config: ChannelsConfig = { version: 1, channels, appliedPresetModelUpdates: ['glm-5.3-candidates-v1'] }
  writeFileSync(channelsPath, JSON.stringify(config))
}
const createInput: ChannelCreateInput = {
  name: 'Fixture new', provider: 'custom', baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'sk-fixture-new-secret', models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }], enabled: true,
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'profer-channel-storage-'))
  process.env.PROFER_CONFIG_DIR = configDir
  channelsPath = join(configDir, 'channels.json')
  identityFails = false
  commercial = false
  selfConfig = true
  refreshCalls = 0
  requests.length = 0
})
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('渠道存储 fail-closed 与原子写', () => {
  test('Given 文件不存在 When 创建 Then 可创建且凭据仅以密文落盘', () => {
    expect(listChannels()).toEqual([])
    const channel = createChannel(createInput)
    expect(decryptApiKey(channel.id)).toBe(createInput.apiKey)
    expect(readFileSync(channelsPath, 'utf8')).not.toContain(createInput.apiKey)
    expect(existsSync(channelsPath + '.tmp')).toBe(false)
  })

  test('Given 损坏 JSON 或非法结构 When 读取和 CRUD Then 抛错且保留原始字节', () => {
    const channel = fixtureChannel()
    for (const raw of ['{broken', '', '{}', '{"version":1,"channels":null}',
      JSON.stringify({ version: 1, channels: [{ ...channel, models: null }] }),
      JSON.stringify({ version: 1, channels: [{ ...channel, models: [{ id: '', name: 'bad', enabled: true }] }] }),
      JSON.stringify({ version: 1, channels: [{ ...channel, serverManaged: 'true' }] }),
      JSON.stringify({ version: 2, channels: [] })]) {
      writeFileSync(channelsPath, raw)
      for (const action of [() => listChannels(), () => createChannel(createInput),
        () => updateChannel(channel.id, { enabled: false }), () => deleteChannel(channel.id)]) {
        expect(action).toThrow('渠道配置损坏')
        expect(readFileSync(channelsPath, 'utf8')).toBe(raw)
      }
      expect(existsSync(channelsPath + '.bak')).toBe(false)
    }
  })

  test('Given 配置路径不可读取 When 创建 Then 不当作不存在文件覆盖', () => {
    mkdirSync(channelsPath)
    expect(() => listChannels()).toThrow('读取渠道配置失败')
    expect(() => createChannel(createInput)).toThrow('读取渠道配置失败')
    expect(existsSync(channelsPath)).toBe(true)
  })

  test('Given 临时写入失败 When 修改 Then 原文件及备份保留前版', () => {
    const channel = fixtureChannel()
    writeConfig([channel])
    const original = readFileSync(channelsPath, 'utf8')
    mkdirSync(channelsPath + '.tmp')
    expect(() => updateChannel(channel.id, { name: 'Changed' })).toThrow('写入渠道配置失败')
    expect(readFileSync(channelsPath, 'utf8')).toBe(original)
    expect(readFileSync(channelsPath + '.bak', 'utf8')).toBe(original)
  })

  test('Given rename 失败 When 原子提交 Then 未覆盖目标内容', () => {
    // 用非空目录阻止最终 rename；直接验证现有 helper 的原子提交边界。
    const { writeJsonFileAtomic } = require('./safe-file') as typeof import('./safe-file')
    const target = join(configDir, 'fixture-target')
    mkdirSync(target)
    writeFileSync(join(target, 'marker'), 'fixture-old-content')
    expect(() => writeJsonFileAtomic(target, { fixture: true })).toThrow()
    expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('fixture-old-content')
    expect(existsSync(target + '.tmp')).toBe(true)
  })

  test('Given 旧版渠道需要迁移 When 读取 Then 原子迁移并保留原始备份', () => {
    const channel = fixtureChannel()
    delete channel.agentRuntimes
    const original = JSON.stringify({ version: 1, channels: [channel] })
    writeFileSync(channelsPath, original)
    expect(listChannels()[0]?.agentRuntimes).toEqual(['pi'])
    expect(readFileSync(channelsPath + '.bak', 'utf8')).toBe(original)
    expect(existsSync(channelsPath + '.tmp')).toBe(false)
  })

  test('Given 迁移写入失败 When 读取 Then 返回内存迁移且保留原文件', () => {
    const channel = fixtureChannel()
    delete channel.agentRuntimes
    const original = JSON.stringify({ version: 1, channels: [channel] })
    writeFileSync(channelsPath, original)
    mkdirSync(channelsPath + '.tmp')
    expect(listChannels()[0]?.agentRuntimes).toEqual(['pi'])
    expect(readFileSync(channelsPath, 'utf8')).toBe(original)
  })

  test('Given 加密失败 When 创建或改 key Then 不生成明文文件或覆盖已有凭据', () => {
    identityFails = true
    expect(() => createChannel(createInput)).toThrow('加密令牌失败')
    expect(existsSync(channelsPath)).toBe(false)
    identityFails = false
    const channel = fixtureChannel()
    writeConfig([channel])
    listChannels()
    const original = readFileSync(channelsPath, 'utf8')
    identityFails = true
    expect(() => updateChannel(channel.id, { apiKey: 'sk-fixture-new-secret' })).toThrow('加密令牌失败')
    expect(readFileSync(channelsPath, 'utf8')).toBe(original)
    expect(() => backupChannelsForAccount('fixture-account')).toThrow('加密令牌失败')
    expect(existsSync(channelsPath + '.logout-backup-fixture-account')).toBe(false)
  })

  test('Given 坏密文 When 普通字段修改 Then 保留原密文且查看明确失败', () => {
    const channel = fixtureChannel({ provider: 'xai', credentialMode: 'oauth', apiKey: 'proferss1:AAAA' })
    writeConfig([channel])
    expect(() => decryptApiKey(channel.id)).toThrow('解密令牌失败')
    expect(updateChannel(channel.id, { enabled: false, provider: 'xai', credentialMode: 'oauth' }).apiKey).toBe(channel.apiKey)
    expect(updateChannel(channel.id, { credentialMode: 'api-key', apiKey: 'sk-fixture-replacement' }).credentialMode).toBe('api-key')
    expect(decryptApiKey(channel.id)).toBe('sk-fixture-replacement')
  })

  test('Given 本地配置损坏 When 恢复合法加密备份 Then 保留两份文件并返回错误', () => {
    writeConfig([fixtureChannel()])
    const backupPath = backupChannelsForAccount('fixture-account')!
    writeFileSync(channelsPath, '{broken')
    expect(restoreChannelsForAccount('fixture-account')).toMatchObject({ restored: 0, backupRetained: true })
    expect(readFileSync(channelsPath, 'utf8')).toBe('{broken')
    expect(existsSync(backupPath)).toBe(true)
  })
})

describe('xAI 局部更新及官方保护', () => {
  test('Given xAI API-key When 只更新 enabled/models/key Then 保留认证和实验字段', () => {
    const channel = fixtureChannel({ provider: 'xai', credentialMode: 'api-key', agentExperimentalEnabled: true })
    writeConfig([channel])
    for (const patch of [{ enabled: false }, { models: channel.models }, { apiKey: 'sk-fixture-next' }]) {
      expect(updateChannel(channel.id, patch)).toMatchObject({ credentialMode: 'api-key', agentExperimentalEnabled: true })
    }
    expect(updateChannel(channel.id, { agentExperimentalEnabled: false }).agentExperimentalEnabled).toBe(false)
    expect(updateChannel(channel.id, { provider: 'openai' })).toMatchObject({ credentialMode: undefined, agentExperimentalEnabled: undefined })
  })

  test('Given xAI OAuth When 刷新凭据 Then 保留实验状态且保持 OAuth', () => {
    const credentials = { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }
    const channel = fixtureChannel({ provider: 'xai', credentialMode: 'oauth', agentExperimentalEnabled: true,
      apiKey: encryptToken(JSON.stringify(credentials)) })
    writeConfig([channel])
    persistXaiOAuthCredentials(channel.id, { ...credentials, access: 'fixture-new-access' })
    expect(getChannelById(channel.id)).toMatchObject({ credentialMode: 'oauth', agentExperimentalEnabled: true })
    expect(JSON.parse(decryptApiKey(channel.id)).access).toBe('fixture-new-access')
    expect(() => updateChannel(channel.id, { credentialMode: 'api-key' })).toThrow('填写新的 xAI API Key')
  })

  test('Given 完整 serverManaged 对象或旧 newapi ID When 结构更新/删除 Then 始终阻止', () => {
    for (const identity of [{ id: 'fixture-managed', serverManaged: true }, { id: 'newapi-fixture', serverManaged: false }]) {
      const channel = fixtureChannel(identity)
      writeConfig([channel])
      for (const patch of [{ name: 'Changed' }, { apiKey: '' }, { credentialMode: 'oauth' as const },
        { agentExperimentalEnabled: true }, { models: [{ ...channel.models[0]!, name: 'Changed' }] }, { models: [] }]) {
        expect(() => updateChannel(channel.id, patch)).toThrow('官方渠道')
      }
      expect(() => deleteChannel(channel.id)).toThrow('官方同步渠道不可删除')
      expect(updateChannel(channel.id, { enabled: false }).enabled).toBe(false)
    }
  })

  test('Given 商业模式无自配权限 When 官方模型启停和 1M Then 允许但结构仍受保护', () => {
    const channel = fixtureChannel({ serverManaged: true })
    writeConfig([channel])
    commercial = true
    selfConfig = false
    expect(updateChannel(channel.id, { models: [{ ...channel.models[0]!, enabled: false, context1m: true }] }).models[0])
      .toMatchObject({ enabled: false, context1m: true })
    expect(() => updateChannel(channel.id, { name: 'Changed' })).toThrow('官方渠道')
  })

  test('Given 普通自配渠道 When 更新和删除 Then 不误用官方保护', () => {
    const channel = fixtureChannel({ serverManaged: false })
    writeConfig([channel])
    expect(updateChannel(channel.id, { name: 'Changed' }).name).toBe('Changed')
    deleteChannel(channel.id)
    expect(listChannels()).toEqual([])
  })
})

describe('Codex 额度使用 access 而不是 OAuth JSON', () => {
  test('Given 有效凭据 When 查额度 Then Bearer 仅为 access 且无刷新请求', async () => {
    const credentials: CodexOAuthCredentials = { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }
    const channel = fixtureChannel({ provider: 'openai-codex', apiKey: encryptToken(JSON.stringify(credentials)) })
    writeConfig([channel])
    expect((await getChannelPlanQuota(channel.id)).supported).toBe(true)
    expect(new Headers(requests[0]?.headers).get('Authorization')).toBe('Bearer fixture-access')
    expect(refreshCalls).toBe(0)
  })

  test('Given 无效凭据 When 查额度 Then 返回失败且不发出网络请求', async () => {
    const channel = fixtureChannel({ provider: 'openai-codex', apiKey: encryptToken('sk-fixture-not-oauth') })
    writeConfig([channel])
    expect((await getChannelPlanQuota(channel.id)).supported).toBe(false)
    expect(requests).toHaveLength(0)
    expect(refreshCalls).toBe(0)
  })

  test('Given 过期凭据 When 并发查额度 Then 一次刷新、加密回写且查询均用新 access', async () => {
    const channel = fixtureChannel({ provider: 'openai-codex', apiKey: encryptToken(JSON.stringify({
      access: 'fixture-old-access', refresh: 'fixture-old-refresh', expires: 1, accountId: 'fixture-account',
    })) })
    writeConfig([channel])
    const results = await Promise.all([getChannelPlanQuota(channel.id), getChannelPlanQuota(channel.id)])
    expect(refreshCalls).toBe(1)
    expect(requests.map((request) => new Headers(request.headers).get('Authorization')))
      .toEqual(['Bearer fixture-new-access', 'Bearer fixture-new-access'])
    expect(JSON.parse(decryptApiKey(channel.id))).toMatchObject({ access: 'fixture-new-access', accountId: 'fixture-account' })
    expect(readFileSync(channelsPath, 'utf8')).not.toContain('fixture-new-refresh')
    expect(results[0]?.channelUpdatedAt).toBe(getChannelById(channel.id)?.updatedAt)
  })
})
