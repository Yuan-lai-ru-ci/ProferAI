import { describe, expect, mock, test } from 'bun:test'
import type { Channel, ChannelsConfig } from '@profer/shared'

// 渠道来源判定已收口到发行版契约；本用例校验的是商业版“官方渠道不算用户自配”的行为。
mock.module('./edition', () => ({
  editionProviders: {
    id: 'commercial',
    account: {
      getSession: async () => null,
      recoverSession: async () => null,
      getSessionSnapshot: () => null,
      getSessionGeneration: () => null,
      refreshSession: async () => true,
      restoreSession: async () => false,
      scheduleAutoRefresh: () => {},
      getMembership: () => ({ commercialMode: true, membershipTier: 'pro', canSelfConfig: true }),
    },
    credentials: { shouldUseManagedRoute: () => true, shouldUseBearerAuth: () => true },
    errors: { detectInsufficientCredits: () => null },
    channels: {
      isManagedChannel: (channel: { id: string; serverManaged?: boolean }) =>
        channel.serverManaged === true || channel.id.startsWith('newapi-'),
    },
    remote: { getRelayTicket: async () => null },
    registerIpc: () => {},
  },
}))

const { applyPresetModelCandidateUpdates, filterUserManagedChannels } = await import('./channel-manager')

function createChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'channel-1',
    name: 'Zhipu',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'encrypted',
    models: [{ id: 'glm-5.2', name: 'GLM-5.2', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('渠道归属：用户自配 vs 官方代管', () => {
  test('keeps self-configured channels and excludes official managed channels', () => {
    const channels = [
      createChannel({ id: 'local-channel' }),
      createChannel({ id: 'newapi-gpt', serverManaged: true }),
      createChannel({ id: 'newapi-legacy' }),
    ]

    expect(filterUserManagedChannels(channels).map((channel) => channel.id)).toEqual(['local-channel'])
  })
})

describe('GLM-5.3 preset model migration', () => {
  test('Given an existing Zhipu channel When applying the update Then appends GLM-5.3 disabled without changing enabled models', () => {
    const config: ChannelsConfig = { version: 1, channels: [createChannel()] }

    const result = applyPresetModelCandidateUpdates(config)

    expect(result.changed).toBe(true)
    expect(result.config.channels[0]?.models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2', enabled: true },
      { id: 'glm-5.3', name: 'GLM-5.3', enabled: false },
    ])
    expect(result.config.appliedPresetModelUpdates).toContain('glm-5.3-candidates-v1')
  })

  test('Given the update was already applied When reloading Then it is idempotent and does not restore a user-removed candidate', () => {
    const config: ChannelsConfig = {
      version: 1,
      channels: [createChannel()],
      appliedPresetModelUpdates: ['glm-5.3-candidates-v1'],
    }

    const result = applyPresetModelCandidateUpdates(config)

    expect(result.changed).toBe(false)
    expect(result.config).toBe(config)
    expect(result.config.channels[0]?.models).toHaveLength(1)
  })

  test('Given an unrelated channel When applying the update Then preserves it while recording the one-time update', () => {
    const config: ChannelsConfig = {
      version: 1,
      channels: [createChannel({ provider: 'anthropic', name: 'Anthropic' })],
    }

    const result = applyPresetModelCandidateUpdates(config)

    expect(result.config.channels[0]?.models).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2', enabled: true }])
    expect(result.config.appliedPresetModelUpdates).toContain('glm-5.3-candidates-v1')
  })
})
