import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgentAdapter, type PiAgentQueryOptions } from '@profer/agent-provider-pi'
import type { SDKMessage } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createClaudeSdkDouble } from '../../../packages/agent-provider-claude/test-hosts/claude-sdk-double'

// 捕获 Core 交给 provider 的真实准备参数；外部模型/进程用替身，禁止联网。
test('Core Pi 下一轮应用会话覆盖、预设与所属Core默认推理设置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-reasoning-pi-'))
  const calls: PiAgentQueryOptions[] = []
  const query = spyOn(PiAgentAdapter.prototype, 'query').mockImplementation(async function* (input) {
    calls.push(input)
    yield { type: 'result', subtype: 'success', session_id: input.sessionId, uuid: crypto.randomUUID(), usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 } as SDKMessage
  })
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'offline', name: 'offline', provider: 'openai-codex', apiKey: 'unused' }],
  })
  try {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ agentThinking: { type: 'enabled' }, agentEffort: 'medium' }))
    await writeFile(join(root, 'agent-presets.json'), JSON.stringify({ presets: [
      { id: 'reasoning', name: 'reasoning', description: '离线推理夹具', createdAt: 0, updatedAt: 0, effort: 'low', promptSections: [], skillSlugs: [], mcpServerNames: [] },
    ] }))
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'reasoning', runtime: 'pi', channelId: 'offline',
      presetReference: { presetId: 'reasoning', presetScope: 'user-global' } })
    const run = async () => {
      const outcome = await runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'offline reasoning fixture')).promise
      expect(outcome).toEqual({ status: 'completed' })
      return calls.at(-1)!
    }
    expect(await run()).toMatchObject({ thinkingLevel: 'low', codexFastMode: false })
    await runtime.updateSessionMeta(session.id, { agentEffort: 'max', codexFastMode: true })
    expect(await run()).toMatchObject({ thinkingLevel: 'xhigh', codexFastMode: true })
    await runtime.updateSessionMeta(session.id, { openAIThinkingLevel: 'off' })
    expect(await run()).toMatchObject({ thinkingLevel: 'off', openAIThinkingLevel: 'off', codexFastMode: true })
    await runtime.updateSessionMeta(session.id, { agentEffort: null, openAIThinkingLevel: null, codexFastMode: false })
    const cleared = await run()
    expect(cleared).toMatchObject({ thinkingLevel: 'low', codexFastMode: false })
    expect(cleared.openAIThinkingLevel).toBeUndefined()
    await writeFile(join(root, 'agent-presets.json'), JSON.stringify({ presets: [
      { id: 'reasoning', name: 'reasoning', description: '离线推理夹具', createdAt: 0, updatedAt: 0, promptSections: [], skillSlugs: [], mcpServerNames: [] },
    ] }))
    expect(await run()).toMatchObject({ thinkingLevel: 'medium' })
    await writeFile(join(root, 'settings.json'), JSON.stringify({ agentThinking: { type: 'disabled' }, agentEffort: 'high' }))
    expect(await run()).toMatchObject({ thinkingLevel: 'off' })
  } finally {
    await runtime.shutdown()
    query.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

test('Core Claude 会话effort覆盖预设，清空覆盖后下一轮恢复预设默认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-reasoning-claude-'))
  const sdk = createClaudeSdkDouble()
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
    channels: [{ id: 'offline', name: 'offline', provider: 'anthropic', apiKey: 'unused' }],
  }, { claude: { sdkLoader: async () => sdk.module, spawnProcess: sdk.spawnProcess } })
  try {
    await writeFile(join(root, 'agent-presets.json'), JSON.stringify({ presets: [
      { id: 'reasoning', name: 'reasoning', description: '离线推理夹具', createdAt: 0, updatedAt: 0, effort: 'low', promptSections: [], skillSlugs: [], mcpServerNames: [] },
    ] }))
    const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'reasoning', runtime: 'claude', channelId: 'offline',
      presetReference: { presetId: 'reasoning', presetScope: 'user-global' } })
    const run = async (expected: string) => {
      const before = sdk.state.options
      const handle = runtime.coordinator.run(runtime.createQuery(runtime.sessions.getMeta(session.id)!, 'offline effort fixture'))
      const deadline = Date.now() + 4000
      while (sdk.state.options === before && runtime.coordinator.isRunning(session.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      if (!sdk.state.options) expect(await handle.promise).toEqual({ status: 'completed' })
      expect(sdk.state.options).not.toBe(before)
      expect(sdk.state.options?.effort).toBe(expected)
      sdk.push({ type: 'result', subtype: 'success', session_id: 'offline-native', terminal_reason: 'completed' })
      expect((await handle.promise).status).toBe('completed')
    }
    await runtime.updateSessionMeta(session.id, { agentEffort: 'max' })
    await run('max')
    await runtime.updateSessionMeta(session.id, { agentEffort: null })
    await run('low')
  } finally { await runtime.shutdown(); sdk.dispose(); await rm(root, { recursive: true, force: true }) }
}, 20000)
