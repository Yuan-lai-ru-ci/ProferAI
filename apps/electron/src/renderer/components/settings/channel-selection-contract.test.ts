import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('表单连接测试使用启用模型并分别检查已勾选内核', () => {
  const form = readFileSync(new URL('./ChannelForm.tsx', import.meta.url), 'utf8')
  expect(form).toContain("const selectedModel = models.find((model) => model.enabled)?.id")
  expect(form).toContain('Promise.all(runtimes.map(async (runtime)')
  expect(form).toContain('modelId: selectedModel')
  expect(form).toContain("runtime === 'claude' ? { agentBaseUrl }")
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

test('已有 Agent 绑定按实际模型有效性判断，不只检查任一模型', () => {
  const view = readFileSync(new URL('../agent/AgentView.tsx', import.meta.url), 'utf8')
  expect(view).toContain('isAgentModelSelectionValid(globalChannels, sessionAgentRuntime, agentChannelIds, { channelId: agentChannelId, modelId: agentModelId })')
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
