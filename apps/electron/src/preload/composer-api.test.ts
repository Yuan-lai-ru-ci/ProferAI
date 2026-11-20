import { describe, expect, test } from 'bun:test'
import { createComposerApi } from './composer-api'

function fixture() {
  const calls: unknown[][] = []
  const ipc = { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(undefined) } }
  return { calls, api: createComposerApi(ipc) }
}

describe('composer preload adapter', () => {
  test('preset列表与普通会话命令使用不同传输，复用资源scope封装', async () => {
    const calls: unknown[][] = [], scoped: unknown[][] = []
    const ipc = { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(undefined) } }
    const api = createComposerApi(ipc, (...args: unknown[]) => { scoped.push(args); return Promise.resolve([]) })
    await api.agent.listPresets('same', true)
    await api.agent.updateRuntime('session', 'pi')
    expect(scoped).toEqual([['agent:list-presets', 'same', true]])
    expect(calls).toEqual([['agent:update-session-agent-runtime', 'session', 'pi']])
  })

  test('maps chat actions to existing IPC channels without changing argument order', async () => {
    const { calls, api } = fixture()
    await api.chat.updateModel('conversation-1', 'model-1', 'channel-1')
    await api.chat.openFileDialog()
    expect(calls[0]).toEqual(['chat:update-conversation-model', 'conversation-1', 'model-1', 'channel-1'])
    expect(calls[1]).toEqual(['chat:open-file-dialog'])
  })

  test('maps agent settings and tool actions through the grouped facade', async () => {
    const { calls, api } = fixture()
    await api.agent.updatePermissionMode('session-1', 'plan', 7)
    await api.agent.rebindPreset('session-1', { presetId: 'standard', presetScope: 'builtin-meta' })
    await api.tools.updateState('web-search', { enabled: false })
    expect(calls).toEqual([
      ['agent:update-session-permission-mode', 'session-1', 'plan', 7],
      ['agent:rebind-session-preset-reference', 'session-1', { presetId: 'standard', presetScope: 'builtin-meta' }, undefined],
      ['chat-tool:update-state', 'web-search', { enabled: false }],
    ])
  })
})
