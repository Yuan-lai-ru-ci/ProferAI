import { describe, expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { validateAgentSendBinding } from './agent-send-binding'

const input = { sessionId: 's1', workspaceId: 'ws1', channelId: 'ch2' } as AgentSendInput
const session = { id: 's1', workspaceId: 'ws1', channelId: 'ch1' } as AgentSessionMeta
const channel = { id: 'ch2', enabled: true } as Channel

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
    expect(validateAgentSendBinding(input, session, true, channel)).toEqual({ ok: true })
  })
})
