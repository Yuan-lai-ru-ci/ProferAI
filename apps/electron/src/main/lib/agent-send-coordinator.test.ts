import { describe, expect, test } from 'bun:test'
import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import { coordinateAgentSend } from './agent-send-coordinator'

const input = { sessionId: 's1', workspaceId: 'ws1', channelId: 'ch1' } as AgentSendInput
const session = { id: 's1', workspaceId: 'ws1' } as AgentSessionMeta
const channel = { id: 'ch1', enabled: true } as Channel

function deps(overrides: Partial<Parameters<typeof coordinateAgentSend>[1]> = {}) {
  const calls: string[] = []
  return {
    calls,
    value: {
      getSession: () => session,
      workspaceExists: () => true,
      getChannel: () => channel,
      startMirror: async () => { calls.push('mirror') },
      startAgent: async () => { calls.push('run') },
      onMirrorError: () => { calls.push('mirror-error') },
      ...overrides,
    },
  }
}

describe('SEND_MESSAGE 协调器', () => {
  test('Given 绑定校验失败 When 协调发送 Then 不启动镜像或 Agent', async () => {
    const d = deps({ getSession: () => undefined })
    await expect(coordinateAgentSend(input, d.value)).rejects.toThrow('AGENT_SESSION_NOT_FOUND')
    expect(d.calls).toEqual([])
  })

  test('Given 合法绑定 When 协调发送 Then 先原子启动 Agent 再初始化镜像', async () => {
    const d = deps()
    await coordinateAgentSend(input, d.value)
    expect(d.calls).toEqual(['run', 'mirror'])
  })

  test('Given 镜像失败 When 协调发送 Then 记录后仍运行 Agent', async () => {
    const d = deps({ startMirror: async () => { throw new Error('mirror failed') } })
    await coordinateAgentSend(input, d.value)
    expect(d.calls).toEqual(['run', 'mirror-error'])
  })
})
