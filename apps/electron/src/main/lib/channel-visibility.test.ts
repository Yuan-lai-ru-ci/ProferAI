import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ChannelsConfig } from '@profer/shared'

/**
 * 发行版切换：两个版本共用同一份 channels.json。
 *
 * 商业版写入的服务端下发渠道在开源版里用不了（没有代管通道，baseUrl 为空），
 * 所以开源版只把它们从列表里隐藏，**不删除**——切回商业版时原样恢复。
 * 这里用契约的 OSS 语义做桩，验证「隐藏 + 磁盘不动」两条。
 */
mock.module('./edition', () => ({
  editionProviders: {
    id: 'oss',
    account: {
      getSession: async () => null,
      recoverSession: async () => null,
      getSessionSnapshot: () => null,
      getSessionGeneration: () => null,
      refreshSession: async () => false,
      restoreSession: async () => false,
      scheduleAutoRefresh: () => {},
      getMembership: () => ({ commercialMode: false, membershipTier: '', canSelfConfig: true }),
    },
    credentials: { shouldUseManagedRoute: () => false, shouldUseBearerAuth: () => false },
    errors: { detectInsufficientCredits: () => null },
    channels: {
      isManagedChannel: () => false,
      isChannelVisible: (channel: { id: string; serverManaged?: boolean }) =>
        channel.serverManaged !== true && !channel.id.startsWith('newapi-'),
    },
    remote: { getRelayTicket: async () => null },
    registerIpc: () => {},
  },
}))

const { listChannels, getChannelById } = await import('./channel-manager')

const originalConfigDir = process.env.PROFER_CONFIG_DIR
let configDir: string
let channelsPath: string

function fixtureChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'fixture-self',
    name: 'Fixture 自配',
    provider: 'custom',
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture-encrypted-key',
    models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function writeConfig(channels: Channel[]): void {
  const config: ChannelsConfig = { version: 1, channels }
  writeFileSync(channelsPath, JSON.stringify(config))
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'profer-channel-visibility-'))
  process.env.PROFER_CONFIG_DIR = configDir
  channelsPath = join(configDir, 'channels.json')
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('开源版隐藏商业版残留渠道', () => {
  test('Given 自配渠道与服务端下发渠道混存 When 列渠道 Then 只返回自配渠道', () => {
    writeConfig([
      fixtureChannel({ id: 'self-openai', name: '我的 OpenAI' }),
      // 商业版下发的渠道：baseUrl 为空、走代管通道，开源版无法使用
      fixtureChannel({ id: 'managed-gpt', name: '官方 GPT', baseUrl: '', serverManaged: true }),
      // 旧版官方渠道：早期写入时没有 serverManaged 字段
      fixtureChannel({ id: 'newapi-legacy', name: '官方（旧）', baseUrl: '' }),
    ])

    expect(listChannels().map((channel) => channel.id)).toEqual(['self-openai'])
  })

  test('Given 隐藏发生时 When 检查磁盘 Then 两个渠道都还在（隐藏不是删除）', () => {
    writeConfig([
      fixtureChannel({ id: 'self-openai' }),
      fixtureChannel({ id: 'managed-gpt', baseUrl: '', serverManaged: true }),
    ])

    listChannels()

    // 关键约束：隐藏不是删除。切回商业版时这些渠道要原样回来。
    // 注意不能断言“文件字节不变”：readConfig 会顺带落盘 schema 迁移/预设模型更新，
    // 那是另一条既有行为，与本次隐藏无关。
    const persisted = JSON.parse(readFileSync(channelsPath, 'utf8')) as { channels: Channel[] }
    expect(persisted.channels.map((channel) => channel.id)).toEqual(['self-openai', 'managed-gpt'])
  })

  test('Given 被隐藏的渠道 When 按 ID 读取 Then 仍能取到（内部一致性不受列表过滤影响）', () => {
    writeConfig([fixtureChannel({ id: 'managed-gpt', baseUrl: '', serverManaged: true })])

    expect(listChannels()).toEqual([])
    // 只过滤对外列表：内部按 ID 查找仍应命中，否则切换回商业版前的内部操作会误判“渠道不存在”
    expect(getChannelById('managed-gpt')?.id).toBe('managed-gpt')
  })

  test('Given 全是自配渠道 When 列渠道 Then 全部可见', () => {
    writeConfig([
      fixtureChannel({ id: 'self-a' }),
      fixtureChannel({ id: 'self-b', provider: 'openai' }),
    ])

    expect(listChannels().map((channel) => channel.id)).toEqual(['self-a', 'self-b'])
  })
})
