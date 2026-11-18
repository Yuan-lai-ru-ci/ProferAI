import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { isAgentModelSelectionValid, nextAgentChannelIdsAfterModelSelect, resolveAgentBindingState, resolveAgentModelSelection, resolveAgentRuntimeSelection } from './agent-channel-selection'

describe('历史会话模型有效性', () => {
  test('已停用模型不静默替换为其它模型', () => {
    const disabled = channel('openai', 'openai', ['gpt-5.5'])
    disabled.models[0]!.enabled = false
    expect(isAgentModelSelectionValid([disabled], 'pi', [], { channelId: 'openai', modelId: 'gpt-5.5' })).toBe(false)
  })
  test('已删除渠道报告无效', () => {
    expect(isAgentModelSelectionValid([], 'pi', [], { channelId: 'missing', modelId: 'model' })).toBe(false)
  })
  test('同一渠道 Pi 有效但 Claude 内核关闭时按会话 runtime 判断', () => {
    const enabled = { ...channel('openai', 'openai', ['model']), agentRuntimes: ['pi' as const] }
    expect(isAgentModelSelectionValid([enabled], 'pi', [], { channelId: 'openai', modelId: 'model' })).toBe(true)
    expect(isAgentModelSelectionValid([enabled], 'claude', [], { channelId: 'openai', modelId: 'model' })).toBe(false)
  })
})
describe('会话绑定状态', () => {
  const enabled = channel('openai', 'openai', ['gpt-5.5'])
  const bound = { channelId: 'openai', modelId: 'gpt-5.5' }

  test('未绑定渠道时报告 unbound', () => {
    expect(resolveAgentBindingState([enabled], 'pi', [], null)).toBe('unbound')
    expect(resolveAgentBindingState([enabled], 'pi', [], {})).toBe('unbound')
  })

  test('渠道被删除时报告 channel_missing，而不是「没有可用模型」', () => {
    expect(resolveAgentBindingState([enabled], 'pi', [], { channelId: 'missing', modelId: 'gpt-5.5' })).toBe('channel_missing')
  })

  test('渠道被停用时报告 channel_disabled', () => {
    expect(resolveAgentBindingState([{ ...enabled, enabled: false }], 'pi', [], bound)).toBe('channel_disabled')
  })

  test('渠道在但绑定模型停用或内核不兼容时报告 model_unavailable', () => {
    const modelDisabled = { ...enabled, models: [{ id: 'gpt-5.5', name: 'gpt-5.5', enabled: false }] }
    expect(resolveAgentBindingState([modelDisabled], 'pi', [], bound)).toBe('model_unavailable')
    const piOnly = { ...enabled, agentRuntimes: ['pi' as const] }
    expect(resolveAgentBindingState([piOnly], 'claude', [], bound)).toBe('model_unavailable')
  })

  test('绑定有效时报告 ok', () => {
    expect(resolveAgentBindingState([enabled], 'pi', [], bound)).toBe('ok')
  })
})

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

describe('原生Pi订阅不能由旧Claude白名单创造协议', () => {
  test('Codex/xAI即使在旧白名单中，Claude默认也不得选中', () => {
    expect(resolveAgentModelSelection([channel('codex', 'openai-codex', ['model'])], 'claude', ['codex'])).toBeNull()
    expect(resolveAgentModelSelection([channel('xai', 'xai', ['model'])], 'claude', ['xai'])).toBeNull()
  })
})

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

describe('resolveAgentRuntimeSelection 内核跟着渠道走', () => {
  const piOnly = { ...channel('deepseek', 'deepseek', ['deepseek-flash']), agentRuntimes: ['pi' as const] }
  const claudeCapable = { ...channel('claude', 'anthropic', ['claude-sonnet-4-6']), agentRuntimes: ['pi' as const, 'claude' as const] }

  test('默认 claude 但只有 Pi 渠道时回退 Pi，不再判定成没有 Agent 渠道', () => {
    expect(resolveAgentRuntimeSelection([piOnly], 'claude', [])).toEqual({
      runtime: 'pi',
      channelId: 'deepseek',
      modelId: 'deepseek-flash',
    })
  })

  test('当前内核有可用渠道时保持用户选择的内核', () => {
    expect(resolveAgentRuntimeSelection([piOnly, claudeCapable], 'claude', ['claude'])).toEqual({
      runtime: 'claude',
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })

  test('Pi 内核无可用渠道时回退 Claude', () => {
    const claudeOnly = { ...channel('claude', 'anthropic', ['claude-sonnet-4-6']), agentRuntimes: ['claude' as const] }
    expect(resolveAgentRuntimeSelection([claudeOnly], 'pi', [])).toEqual({
      runtime: 'claude',
      channelId: 'claude',
      modelId: 'claude-sonnet-4-6',
    })
  })

  test('两个内核都没有可用渠道时返回 null', () => {
    expect(resolveAgentRuntimeSelection([{ ...piOnly, enabled: false }], 'claude', [])).toBeNull()
    expect(resolveAgentRuntimeSelection([], 'claude', [])).toBeNull()
  })

  test('回退时沿用当前会话已绑定的渠道与模型', () => {
    expect(resolveAgentRuntimeSelection([piOnly], 'claude', [], {
      channelId: 'deepseek',
      modelId: 'deepseek-flash',
    })).toEqual({ runtime: 'pi', channelId: 'deepseek', modelId: 'deepseek-flash' })
  })
})
