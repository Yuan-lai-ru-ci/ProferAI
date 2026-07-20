import { describe, expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { validateAgentChannelModelBinding, validateAgentSendBinding, validateAgentSessionModelUpdate } from './agent-send-binding'

const input = { sessionId: 's1', workspaceId: 'ws1', channelId: 'ch2' } as AgentSendInput
const session = { id: 's1', workspaceId: 'ws1', channelId: 'ch1' } as AgentSessionMeta
const channel = {
  id: 'ch2',
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
})

describe('Agent 会话模型持久化校验', () => {
  test('Given renderer 未提交完整渠道模型 When 创建或更新 Then 主进程拒绝', () => {
    expect(validateAgentChannelModelBinding(undefined, 'model-enabled', undefined))
      .toMatchObject({ ok: false, code: 'AGENT_CHANNEL_NOT_FOUND' })
    expect(validateAgentChannelModelBinding(channel.id, undefined, channel))
      .toMatchObject({ ok: false, code: 'AGENT_MODEL_NOT_IN_CHANNEL' })
  })

  test('Given session 正在运行或 backgroundWaiting When 更新模型 Then 拒绝且不检查 renderer 选择', () => {
    expect(validateAgentSessionModelUpdate(session.id, channel.id, 'model-enabled', session, channel, true))
      .toMatchObject({ ok: false, code: 'AGENT_SESSION_ACTIVE' })
  })

  test('Given session 空闲且模型属于 enabled 渠道 When 更新模型 Then 允许', () => {
    expect(validateAgentSessionModelUpdate(session.id, channel.id, 'model-enabled', session, channel, false))
      .toEqual({ ok: true })
  })

  test('Given session 不存在或渠道模型无效 When 更新模型 Then 返回稳定错误码', () => {
    expect(validateAgentSessionModelUpdate('missing', channel.id, 'model-enabled', undefined, channel, false))
      .toMatchObject({ ok: false, code: 'AGENT_SESSION_NOT_FOUND' })
    expect(validateAgentSessionModelUpdate(session.id, channel.id, 'model-disabled', session, channel, false))
      .toMatchObject({ ok: false, code: 'AGENT_MODEL_DISABLED' })
  })
})
