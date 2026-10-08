import { describe, expect, test } from 'bun:test'
import type { Channel } from '@profer/shared'
import { resolveQuickTaskModelInfo } from './quick-task-model-eligibility'

const channel = (overrides: Partial<Channel> = {}): Channel => ({
  id: 'fixture-channel',
  name: 'Fixture Channel',
  provider: 'openai',
  baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'fixture-encrypted',
  enabled: true,
  models: [{ id: 'fixture-model', name: 'Fixture Model', enabled: true }],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe('QuickTask 模型资格（fixture）', () => {
  test('Agent 按 runtime、渠道和模型 enabled 同时校验', () => {
    const settings = { agentChannelId: 'fixture-channel', agentModelId: 'fixture-model', agentRuntime: 'pi' as const }
    expect(resolveQuickTaskModelInfo('agent', settings, [channel()])).toEqual({ channelName: 'Fixture Channel', modelId: 'fixture-model' })
    expect(resolveQuickTaskModelInfo('agent', { ...settings, agentRuntime: 'claude' }, [channel({ agentRuntimes: ['pi'] })])).toBeNull()
    expect(resolveQuickTaskModelInfo('agent', settings, [channel({ enabled: false })])).toBeNull()
    expect(resolveQuickTaskModelInfo('agent', settings, [channel({ models: [{ id: 'fixture-model', name: 'Fixture Model', enabled: false }] })])).toBeNull()
  })

  test('Chat 拒绝 Agent-only / Codex / OAuth，并拒绝停用模型', () => {
    const selectedModel = { channelId: 'fixture-channel', modelId: 'fixture-model' }
    expect(resolveQuickTaskModelInfo('chat', {}, [channel()], selectedModel)).toEqual({ channelName: 'Fixture Channel', modelId: 'fixture-model' })
    expect(resolveQuickTaskModelInfo('chat', {}, [channel({ provider: 'openai-codex' })], selectedModel)).toBeNull()
    expect(resolveQuickTaskModelInfo('chat', {}, [channel({ provider: 'xai', credentialMode: 'oauth' })], selectedModel)).toBeNull()
    expect(resolveQuickTaskModelInfo('chat', {}, [channel({ provider: 'xai', credentialMode: 'api-key' })], selectedModel)).toEqual({ channelName: 'Fixture Channel', modelId: 'fixture-model' })
    expect(resolveQuickTaskModelInfo('chat', {}, [channel({ enabled: false })], selectedModel)).toBeNull()
    expect(resolveQuickTaskModelInfo('chat', {}, [channel({ models: [{ id: 'fixture-model', name: 'Fixture Model', enabled: false }] })], selectedModel)).toBeNull()
    expect(resolveQuickTaskModelInfo('chat', {}, [channel()], { ...selectedModel, modelId: 'missing' })).toBeNull()
  })
})
