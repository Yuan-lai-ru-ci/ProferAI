import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ChannelsConfig } from '@profer/shared'

mock.module('./edition', () => ({
  editionProviders: {
    id: 'oss',
    account: {
      getSession: async () => null, recoverSession: async () => null, getSessionSnapshot: () => null,
      getSessionGeneration: () => null, refreshSession: async () => false, restoreSession: async () => false,
      scheduleAutoRefresh: () => {},
      getMembership: () => ({ commercialMode: false, membershipTier: '', canSelfConfig: true }),
    },
    credentials: { shouldUseManagedRoute: () => false, shouldUseBearerAuth: () => false },
    errors: { detectInsufficientCredits: () => null },
    channels: {
      isManagedChannel: () => false,
      isChannelVisible: (c: { id: string; serverManaged?: boolean }) => c.serverManaged !== true && !c.id.startsWith('newapi-'),
    },
    remote: { getRelayTicket: async () => null },
    registerIpc: () => {},
  },
}))

const { listChannels, decryptApiKey, deleteChannel, testChannel } = await import('./channel-manager')

let dir: string
const original = process.env.PROFER_CONFIG_DIR
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'probe-write-')); process.env.PROFER_CONFIG_DIR = dir })
afterEach(() => { if (original === undefined) delete process.env.PROFER_CONFIG_DIR; else process.env.PROFER_CONFIG_DIR = original; rmSync(dir, { recursive: true, force: true }) })

describe('另一个发行版的渠道在本地必须原样保留', () => {
  function managed(overrides: Partial<Channel> = {}): Channel {
    return {
      id: 'managed-deepseek', name: '官方 DeepSeek', provider: 'deepseek', baseUrl: '',
      serverManaged: true, apiKey: 'enc', models: [], enabled: true, createdAt: 1, updatedAt: 1,
      ...overrides,
    } as Channel
  }

  test('读一次配置不得给代管渠道补默认地址', () => {
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({ version: 1, channels: [managed()] } as ChannelsConfig))

    expect(listChannels()).toEqual([])

    const persisted = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as ChannelsConfig
    // 实测过的真实损害：baseUrl 被补成 https://api.deepseek.com 并写盘。
    expect(persisted.channels[0]?.baseUrl).toBe('')
    // 迁移标记可以写（它属于可见渠道的迁移），但渠道本体不得被改。
    expect(persisted.channels[0]?.name).toBe('官方 DeepSeek')
  })

  test('预设模型迁移不得给代管渠道追加本地模型', () => {
    // zhipu 有 GLM-5.3 候选；官方 zhipu 渠道不应被加上只在本地存在的模型。
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({
      version: 1,
      channels: [managed({ id: 'managed-zhipu', provider: 'zhipu', name: '官方智谱' })],
    } as ChannelsConfig))

    listChannels()

    const persisted = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as ChannelsConfig
    expect(persisted.channels[0]?.models).toEqual([])
  })

  test('不可见渠道不允许被读取密钥、删除或测试', () => {
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({ version: 1, channels: [managed()] } as ChannelsConfig))

    expect(() => decryptApiKey('managed-deepseek')).toThrow('渠道不在当前发行版中')
    expect(() => deleteChannel('managed-deepseek')).toThrow('渠道不在当前发行版中')
    // testChannel 返回结构化失败而不是抛错
    const result = testChannel('managed-deepseek')
    return result.then((value) => {
      expect(value.success).toBe(false)
      expect(value.message).toContain('渠道不在当前发行版中')
    })
  })

  test('可见渠道仍正常迁移（防止修复把正常迁移一起关掉）', () => {
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({
      version: 1,
      channels: [managed({ id: 'self-deepseek', serverManaged: false, name: '我的 DeepSeek' })],
    } as ChannelsConfig))

    listChannels()

    const persisted = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as ChannelsConfig
    // 自配渠道的空 baseUrl 仍应被补成厂商默认地址，否则会破坏既有迁移行为。
    expect(persisted.channels[0]?.baseUrl).toBe('https://api.deepseek.com')
  })
})
