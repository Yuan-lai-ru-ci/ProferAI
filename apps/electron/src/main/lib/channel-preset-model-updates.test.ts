import { describe, expect, test } from 'bun:test'
import type { Channel, ChannelsConfig } from '@profer/shared'
import { applyPresetModelCandidateUpdates } from './channel-manager'

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
