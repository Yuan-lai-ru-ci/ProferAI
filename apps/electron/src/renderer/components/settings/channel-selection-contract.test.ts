import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { Channel } from '@profer/shared'
import { usesIndependentLocalCore } from '@/atoms/core-target-atoms'
import type { CoreTargetsSnapshot } from '../../../types/settings'
import { isAgentModelSelectionValid } from '@/lib/agent-channel-selection'

test('表单连接测试使用启用模型并分别检查已勾选内核', () => {
  const form = readFileSync(new URL('./ChannelForm.tsx', import.meta.url), 'utf8')
  expect(form).toContain("const selectedModel = models.find((model) => model.enabled)?.id")
  expect(form).toContain('Promise.all(runtimes.map(async (runtime)')
  expect(form).toContain('modelId: selectedModel')
  expect(form).toContain("runtime === 'claude' || (runtime === 'pi' && piConsumesAnthropicEndpoint)")
  expect(form).toContain('consumesAgentEndpoint ? { agentBaseUrl }')
})

test('设备登出先确认且失败不会自动关闭确认框', () => {
  const page = readFileSync(new URL('./DevicesSettings.tsx', import.meta.url), 'utf8')
  expect(page).toContain('onClick={() => setRevokeTarget(d)}')
  expect(page).toContain('<AlertDialogTitle>登出此设备？')
  expect(page).toContain('event.preventDefault()')
  expect(page).toContain('if (revokeTarget) void handleRevoke(revokeTarget.id)')
})
test('官方分组保留所有渠道与停用模型的启停入口', () => {
  const panel = readFileSync(new URL('./ChannelSettings.tsx', import.meta.url), 'utf8')
  expect(panel).toContain('onToggleChannel={handleToggle}')
  expect(panel).toContain('onToggleModel={handleToggleModel}')
  expect(panel).toContain('checked={model.enabled}')
  expect(panel).toContain('checked={channel.enabled}')
  expect(panel).toContain("const supportsClaude = isChannelEnabledForRuntime(channel, 'claude')")
  expect(panel).toContain('resolveAgentModelSelection(channels, runtime, agentChannelIds')
})

test('Given 所属Core有效渠道 When 校验历史绑定 Then 检查指定模型且不沿用桌面渠道白名单', () => {
  const view = readFileSync(new URL('../agent/AgentView.tsx', import.meta.url), 'utf8')
  // 接线守卫只盯实际校验调用；模型是否可用由下面的真实函数行为断言覆盖。
  expect(view).toMatch(/isAgentModelSelectionValid\(globalChannels,\s*sessionAgentRuntime,\s*effectiveAgentChannelIds,/)
  expect(view).toContain('const usesCoreCatalog = isRemoteCore || independentCore')
  expect(view).toContain('const independentCore = usesIndependentLocalCore(coreTarget)')
  // 执行组件实际使用的目录选择表达式，避免复制分支实现后测试与接线脱节。
  const expression = view.match(/\(\) => (usesCoreCatalog \? globalChannels\.map\(channel => channel\.id\) : agentChannelIds),/)?.[1]
  expect(expression).toBeDefined()
  const selectIds = new Function('usesCoreCatalog', 'globalChannels', 'agentChannelIds', `return ${expression}`) as (core: boolean, channels: Channel[], ids: string[]) => string[]
  const channel: Channel = { id: 'core-channel', name: 'Core', provider: 'anthropic', baseUrl: '', apiKey: '',
    enabled: true, createdAt: 0, updatedAt: 0,
    models: [{ id: 'bound-model', name: 'Bound', enabled: true }, { id: 'other-model', name: 'Other', enabled: true }] }
  const selection = { channelId: channel.id, modelId: 'bound-model' }
  for (const [currentId, independent, expected] of [['remote', false, true], ['local', true, true], ['local', false, false]] as const) {
    const target: CoreTargetsSnapshot = { currentId, generation: 1, targets: [{ id: currentId, name: currentId, kind: currentId === 'local' ? 'local' : 'remote', status: 'connected', independent }] }
    const usesCoreCatalog = currentId !== 'local' || usesIndependentLocalCore(target)
    const ids = selectIds(usesCoreCatalog, [channel], ['desktop-channel'])
    expect(ids).toEqual(expected ? [channel.id] : ['desktop-channel'])
    expect(isAgentModelSelectionValid([channel], 'claude', ids, selection)).toBe(expected)
  }
  expect(isAgentModelSelectionValid([channel], 'claude', [channel.id], selection)).toBe(true)
  expect(isAgentModelSelectionValid([channel], 'claude', ['desktop-channel'], selection)).toBe(false)
  const unavailable = { ...channel, models: channel.models.map(model => ({ ...model, enabled: model.id !== 'bound-model' })) }
  expect(isAgentModelSelectionValid([unavailable], 'claude', [channel.id], selection)).toBe(false)
  expect(isAgentModelSelectionValid([channel], 'claude', [channel.id], { ...selection, modelId: 'missing' })).toBe(false)
})

test('历史 Agent metadata 缺模型时不会继承其它默认，不自动改写metadata', () => {
  const view = readFileSync(new URL('../agent/AgentView.tsx', import.meta.url), 'utf8')
  expect(view).toContain('sessionMeta ? sessionMetaChannelId ?? null')
  expect(view).toContain('sessionMeta ? sessionMetaModelId ?? null')
  expect(view).not.toContain('自动补全会话模型持久化失败')
  expect(view).not.toContain('computedSelectedModel ?? stableSelectedModelRef.current')
})

test('目录已加载后失效模型不得继续显示上次缓存名称', () => {
  const selector = readFileSync(new URL('../chat/ModelSelector.tsx', import.meta.url), 'utf8')
  expect(selector).toContain('channelsLoaded ? currentModelInfo : null')
})
