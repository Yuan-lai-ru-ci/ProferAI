import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ChannelsConfig } from '@profer/shared'

mock.module('./identity-service', () => ({
  getOrCreateDeviceIdentity: () => ({ deviceId: 'fixture-logout-device' }),
  getDeviceAuthInfo: () => ({ deviceId: 'fixture-logout-device', deviceName: 'fixture', platform: 'darwin' }),
  getUserIdentity: () => ({ userName: 'fixture', avatar: 'F' }),
}))

const { logout } = await import('./auth-service')
const { listChannels } = await import('./channel-manager')
const { encryptToken } = await import('./token-crypto')

const originalConfigDir = process.env.PROFER_CONFIG_DIR
let configDir: string
let channelsPath: string

function fixtureChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'fixture-self',
    name: 'Fixture 自配',
    provider: 'custom',
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: encryptToken('sk-fixture-self-secret'),
    models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }],
    enabled: true,
    agentRuntimes: ['pi'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function writeChannels(channels: Channel[]): void {
  writeFileSync(channelsPath, JSON.stringify({ version: 1, channels }), 'utf-8')
}

function readChannels(): Channel[] {
  return (JSON.parse(readFileSync(channelsPath, 'utf-8')) as ChannelsConfig).channels
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'profer-auth-logout-'))
  process.env.PROFER_CONFIG_DIR = configDir
  channelsPath = join(configDir, 'channels.json')
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('登出：自配 API 不下线', () => {
  test('Given 自配渠道与官方渠道 When 登出 Then 自配渠道与密文凭据原样保留，仅清理官方渠道', async () => {
    const selfChannel = fixtureChannel()
    writeChannels([
      selfChannel,
      fixtureChannel({ id: 'fixture-managed', name: '官方', serverManaged: true }),
    ])

    const result = await logout()

    expect(result.channelsCleared).toBe(true)
    expect(result.channelsBackedUp).toBe(false)
    expect(result.warning).toBeUndefined()

    const remaining = readChannels()
    expect(remaining.map((channel) => channel.id)).toEqual(['fixture-self'])
    expect(remaining[0]?.apiKey).toBe(selfChannel.apiKey)
    // 不再产生「加密备份」文件
    expect(existsSync(`${channelsPath}.logout-backup-fixture-account`)).toBe(false)
  })

  test('Given 只有自配渠道 When 登出 Then 渠道文件内容不变', async () => {
    writeChannels([fixtureChannel()])
    listChannels() // 先让读取期迁移（如预设模型更新）落盘，避免把迁移误判为登出写盘
    const before = readFileSync(channelsPath, 'utf-8')

    const result = await logout()

    expect(result.channelsCleared).toBe(false)
    expect(readFileSync(channelsPath, 'utf-8')).toBe(before)
  })
})
