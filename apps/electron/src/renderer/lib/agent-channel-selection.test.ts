import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { nextAgentChannelIdsAfterModelSelect, resolveAgentModelSelection } from './agent-channel-selection'

function channel(id: string, provider: Channel['provider'], models: string[]): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    models: models.map((modelId) => ({ id: modelId, name: modelId, enabled: true })),
  }
}

describe('nextAgentChannelIdsAfterModelSelect', () => {
  test('adds the selected channel for Claude runtime', () => {
    expect(nextAgentChannelIdsAfterModelSelect(['anthropic'], 'kimi', 'claude')).toEqual(['anthropic', 'kimi'])
  })

  test('keeps the list unchanged when Claude channel is already present', () => {
    const channelIds = ['anthropic', 'kimi']
    expect(nextAgentChannelIdsAfterModelSelect(channelIds, 'kimi', 'claude')).toBe(channelIds)
  })

  test('does not mark Pi-selected channels as Claude-compatible', () => {
    const channelIds = ['anthropic']
    expect(nextAgentChannelIdsAfterModelSelect(channelIds, 'openai-responses', 'pi')).toBe(channelIds)
  })

  test('does not migrate a Pi default channel into the Claude whitelist', () => {
    const channelIds: string[] = []
    expect(nextAgentChannelIdsAfterModelSelect(channelIds, 'openai-responses', 'pi')).toBe(channelIds)
  })
})

describe('resolveAgentModelSelection', () => {
  const channels = [
    channel('claude', 'anthropic', ['claude-sonnet-4-6']),
    channel('openai', 'openai', ['gpt-5.5']),
    channel('ollama', 'ollama', ['qwen3:8b']),
  ]

  test('Pi selects an OpenAI protocol model', () => {
    expect(resolveAgentModelSelection(channels, 'pi', ['claude'])).toEqual({
      channelId: 'openai',
      modelId: 'gpt-5.5',
    })
  })

  test('Claude can select Ollama through its Anthropic-compatible protocol', () => {
    expect(resolveAgentModelSelection([channels[2]!], 'claude', ['ollama'])).toEqual({
      channelId: 'ollama',
      modelId: 'qwen3:8b',
    })
  })

  test('Claude selects an Anthropic protocol model from its whitelist', () => {
    expect(resolveAgentModelSelection(channels, 'claude', ['claude'])).toEqual({
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })

  test('Pi keeps a Claude model as the current selection', () => {
    expect(resolveAgentModelSelection(channels, 'pi', ['claude'], {
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })).toEqual({
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })

  test('Pi falls back to an Anthropic protocol model when no OpenAI model exists', () => {
    expect(resolveAgentModelSelection([channels[0]!], 'pi', [])).toEqual({
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })

  test('Pi keeps the current Claude model selection', () => {
    expect(resolveAgentModelSelection(channels, 'pi', [], {
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })).toEqual({
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })
})
