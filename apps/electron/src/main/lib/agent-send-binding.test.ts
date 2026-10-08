import { describe, expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { validateAgentSendBinding } from './agent-send-binding'

const input = { sessionId: 's1', workspaceId: 'ws1', channelId: 'ch2' } as AgentSendInput
const session = { id: 's1', workspaceId: 'ws1', channelId: 'ch1' } as AgentSessionMeta
const channel = {
  id: 'ch2',
  provider: 'anthropic',
  enabled: true,
  models: [
    { id: 'model-enabled', name: 'Enabled model', enabled: true },
    { id: 'model-disabled', name: 'Disabled model', enabled: false },
  ],
} as Channel

describe('Agent 消息发送归属校验', () => {
  test('Given 不存在 session When 校验 Then 拒绝且返回稳定错误码', () => {
    expect(validateAgentSendBinding(input, undefined, true, channel)).toMatchObject({ ok: false, code: 'AGENT_SESSION_NOT_FOUND' })
  })

  test('Given workspace 不匹配或已删除 When 校验 Then 拒绝', () => {
    expect(validateAgentSendBinding({ ...input, workspaceId: 'ws2' }, session, true, channel)).toMatchObject({ ok: false, code: 'AGENT_SESSION_WORKSPACE_MISMATCH' })
    expect(validateAgentSendBinding(input, session, false, channel)).toMatchObject({ ok: false, code: 'AGENT_WORKSPACE_NOT_FOUND' })
  })

  test('Given 渠道不存在或停用 When 校验 Then 拒绝', () => {
    expect(validateAgentSendBinding(input, session, true, undefined)).toMatchObject({ ok: false, code: 'AGENT_CHANNEL_NOT_FOUND' })
    expect(validateAgentSendBinding(input, session, true, { ...channel, enabled: false })).toMatchObject({ ok: false, code: 'AGENT_CHANNEL_DISABLED' })
  })

  test('Given session 历史渠道不同但请求渠道已启用 When 校验 Then 保留合法切换', () => {
    expect(validateAgentSendBinding({ ...input, modelId: 'model-enabled' }, session, true, channel)).toEqual({ ok: true })
  })

  test('Given session runtime 已切换 When 延迟的旧 runtime 请求到达 Then 在启动 SDK 前拒绝', () => {
    const piSession = { ...session, agentRuntime: 'pi' } as AgentSessionMeta
    expect(validateAgentSendBinding({ ...input, agentRuntime: 'claude' }, piSession, true, channel))
      .toMatchObject({ ok: false, code: 'AGENT_SESSION_RUNTIME_MISMATCH' })
    expect(validateAgentSendBinding({ ...input, agentRuntime: 'pi' }, piSession, true, channel)).toEqual({ ok: true })
  })

  test('Given model 不属于渠道或已停用 When 校验 Then 在启动 SDK 前拒绝', () => {
    expect(validateAgentSendBinding({ ...input, modelId: 'other-channel-model' }, session, true, channel))
      .toMatchObject({ ok: false, code: 'AGENT_MODEL_NOT_IN_CHANNEL' })
    expect(validateAgentSendBinding({ ...input, modelId: 'model-disabled' }, session, true, channel))
      .toMatchObject({ ok: false, code: 'AGENT_MODEL_DISABLED' })
  })

  test.each(['pi', 'claude'] as const)('Given 渠道关闭 %s When 旧会话发送 Then 在 main 拒绝', (runtime) => {
    const runtimeSession = { ...session, agentRuntime: runtime }
    const otherRuntime = runtime === 'pi' ? 'claude' : 'pi'
    expect(validateAgentSendBinding(input, runtimeSession, true, { ...channel, agentRuntimes: [otherRuntime] }))
      .toMatchObject({ ok: false, code: 'AGENT_CHANNEL_RUNTIME_DISABLED' })
    expect(validateAgentSendBinding(input, runtimeSession, true, { ...channel, agentRuntimes: [] }))
      .toMatchObject({ ok: false, code: 'AGENT_CHANNEL_RUNTIME_DISABLED' })
    expect(validateAgentSendBinding(input, runtimeSession, true, { ...channel, agentRuntimes: [runtime] }))
      .toEqual({ ok: true })
  })

  test('Given 老 Codex 渠道 When Claude/Pi 会话发送 Then 按历史内核资格校验', () => {
    const codex = { ...channel, provider: 'openai-codex' as const }
    expect(validateAgentSendBinding(input, session, true, codex))
      .toMatchObject({ ok: false, code: 'AGENT_CHANNEL_RUNTIME_DISABLED' })
    expect(validateAgentSendBinding(input, { ...session, agentRuntime: 'pi' }, true, codex)).toEqual({ ok: true })
  })

  test('Given xAI 错误勾选 Claude When main 校验 Then 拒绝无 Anthropic 协议的请求', () => {
    expect(validateAgentSendBinding(input, session, true, { ...channel, provider: 'xai', agentRuntimes: ['claude'] }))
      .toMatchObject({ ok: false, code: 'AGENT_CHANNEL_RUNTIME_DISABLED' })
  })
})
