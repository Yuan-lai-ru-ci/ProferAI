import { afterEach, describe, expect, test } from 'bun:test'
import { CoreClient, type CoreWebSocket } from './core-client'
import { attachLocalCoreClient, detachLocalCoreClient, setLocalCorePublisher, prepareLocalCoreMessage, sendLocalCoreMessage, shouldUseLocalCorePi } from './core-local-bridge'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import type { AgentSendInput, AgentSessionMeta, Channel } from '@profer/shared'
import type { CredentialPort, RuntimeCredential } from '@profer/agent-runtime'
import { normalizeUserSendInput } from './agent-input-origin'

afterEach(() => { detachLocalCoreClient(); setLocalCorePublisher(() => {}) })

const session: AgentSessionMeta = {
  id: 'session-1', title: 'existing session', agentRuntime: 'pi',
  channelId: 'deleted-channel', modelId: 'old-model', createdAt: 1, updatedAt: 1,
}
const channel: Channel = {
  id: 'current-channel', name: 'test', provider: 'anthropic', apiKey: 'encrypted-placeholder', baseUrl: 'https://api.anthropic.com',
  enabled: true, agentRuntimes: ['pi'], models: [{ id: 'current-model', name: 'test', enabled: true }],
  createdAt: 1, updatedAt: 1,
}
const input: AgentSendInput = normalizeUserSendInput({
  sessionId: session.id, channelId: channel.id, modelId: 'current-model',
  userMessage: 'model prompt', rawUserMessage: 'display prompt', uuid: 'user-message-id', agentRuntime: 'pi',
})

function dependencies(credentials: CredentialPort) {
  return { getSession: () => session, getChannel: (id: string) => id === channel.id ? channel : undefined, credentials }
}

describe('本地 Core 每轮请求', () => {
  test('每次解析最新凭据，使用本次渠道和模型，并保留真实作者/UUID/展示正文', async () => {
    let credentials: RuntimeCredential = { apiKey: 'first-test-key', provider: 'anthropic', baseUrl: 'https://first.test', forceBearerAuth: false }
    const calls: unknown[] = []
    const deps = dependencies({ async resolve(request) { calls.push(request); return { ok: true, credentials } } })
    const first = await prepareLocalCoreMessage(input, deps)
    credentials = { ...credentials, apiKey: 'second-test-key', baseUrl: 'https://second.test' }
    const second = await prepareLocalCoreMessage({ ...input, uuid: 'second-user-message' }, deps)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ sessionId: session.id, runtime: 'pi', channelId: channel.id, modelId: 'current-model' })
    expect(first.credentials?.apiKey).toBe('first-test-key')
    expect(second.credentials?.apiKey).toBe('second-test-key')
    expect(second.credentials?.baseUrl).toBe('https://second.test')
    expect(first).toMatchObject({ channelId: channel.id, modelId: 'current-model', uuid: input.uuid, rawUserMessage: 'display prompt' })
    expect(first.context).toMatchObject({ messageAuthor: { type: 'user' }, trigger: { id: `message:${session.id}:${input.uuid}`, actor: { type: 'user' }, authorization: { kind: 'direct' } } })
    expect(second.context?.trigger.id).not.toBe(first.context?.trigger.id)
  })

  test('渠道删除与凭据解密失败保持不同错误，异常不泄漏凭据', async () => {
    let resolutions = 0
    const deps = dependencies({ async resolve() { resolutions++; return { ok: false, code: 'api_key_decrypt_failed' } } })
    await expect(prepareLocalCoreMessage({ ...input, channelId: 'deleted-channel' }, deps)).rejects.toThrow('AGENT_CHANNEL_NOT_FOUND')
    expect(resolutions).toBe(0)
    await expect(prepareLocalCoreMessage(input, deps)).rejects.toThrow('api_key_decrypt_failed: 无法解密')
    expect(resolutions).toBe(1)
  })

  test('非法模型不进入凭据解析；生成缺失 UUID，发送完整每轮快照', async () => {
    const deps = dependencies({ async resolve() { return { ok: true, credentials: { apiKey: 'test-only', provider: 'anthropic', baseUrl: undefined, forceBearerAuth: false } } } })
    await expect(prepareLocalCoreMessage({ ...input, modelId: 'other-model' }, deps)).rejects.toThrow('AGENT_MODEL_NOT_IN_CHANNEL')
    const prepared = await prepareLocalCoreMessage({ ...input, uuid: undefined }, deps)
    expect(prepared.uuid).toBeTruthy()
    expect(prepared.context?.trigger.id).toBe(`message:${input.sessionId}:${prepared.uuid}`)
    const bodies: unknown[] = []
    const socket: CoreWebSocket = {
      readyState: 0, onopen: null, onerror: null, onclose: null, onmessage: null,
      send(value) {
        const command = JSON.parse(value)
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ kind: 'command_result', commandId: command._cmdId, ok: true, data: {} }) }))
      },
      close() { this.readyState = 3; this.onclose?.() },
    }
    attachLocalCoreClient(new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'test-only', reconnect: false,
      webSocketFactory: () => { queueMicrotask(() => { socket.readyState = 1; socket.onopen?.() }); return socket },
      fetchImpl: async (_url, init) => { if (init?.body) bodies.push(JSON.parse(String(init.body))); return Response.json({ accepted: true, sessionId: session.id }) },
    }))
    await sendLocalCoreMessage(session.id, input.userMessage, prepared)
    expect(bodies).toEqual([{ ...prepared, prompt: input.userMessage }])
  })
})

test('本地工作区事件卸载后不发布，重新挂接与快照恢复只刷新当前Core', async () => {
  class Socket implements CoreWebSocket {
    readyState = 0
    onopen: (() => void) | null = null
    onerror: ((error: unknown) => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    sent: string[] = []
    send(value: string) { this.sent.push(value) }
    close() { this.readyState = 3; this.onclose?.() }
    open() { this.readyState = 1; this.onopen?.() }
    changed(sequence: number) { this.onmessage?.({ data: JSON.stringify({ kind: 'workspace_event', eventId: `fixture:${sequence}`, payload: { type: 'changed' } }) }) }
  }
  const channels: string[] = []
  setLocalCorePublisher(channel => channels.push(channel))
  const firstSocket = new Socket(), secondSocket = new Socket()
  const first = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => firstSocket })
  const second = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => secondSocket })
  try {
    let connected = first.connect(); firstSocket.open(); await connected
    connected = second.connect(); secondSocket.open(); await connected
    attachLocalCoreClient(first)
    firstSocket.changed(1)
    expect(channels).toEqual([AGENT_IPC_CHANNELS.WORKSPACES_CHANGED])
    attachLocalCoreClient(second)
    firstSocket.changed(2)
    expect(channels).toHaveLength(1)
    secondSocket.changed(1)
    expect(channels).toHaveLength(2)
    const snapshot = second.refreshSnapshot()
    await new Promise(resolve => setTimeout(resolve, 0))
    const command = JSON.parse(secondSocket.sent.at(-1)!)
    secondSocket.onmessage?.({ data: JSON.stringify({ kind: 'command_result', commandId: command._cmdId, ok: true,
      data: { sessions: [], goals: [], automations: [], delegations: [], pending: [], cursor: 'fixture:2' } }) })
    await snapshot
    expect(channels.filter(channel => channel === AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)).toHaveLength(3)
    detachLocalCoreClient(false)
    secondSocket.changed(3)
    expect(channels.filter(channel => channel === AGENT_IPC_CHANNELS.WORKSPACES_CHANGED)).toHaveLength(3)
  } finally { first.close(); second.close() }
})

describe('本地 Core Pi 路由', () => {
  test('显式启用但 Core 未就绪时报告错误，不静默回退', () => {
    expect(() => shouldUseLocalCorePi('pi', true)).toThrow('Core 尚未就绪')
  })

  test('关闭Core保留旧路径，显式启用时Claude也必须有Core', () => {
    expect(shouldUseLocalCorePi('pi', false)).toBe(false)
    expect(() => shouldUseLocalCorePi('claude', true)).toThrow('Core 尚未就绪')
  })

  test('已挂接 Core 时 Pi 走 Core，卸载后恢复未就绪保护', () => {
    attachLocalCoreClient(new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'test-only', reconnect: false }))
    expect(shouldUseLocalCorePi('pi', true)).toBe(true)
    detachLocalCoreClient()
    expect(() => shouldUseLocalCorePi('pi', true)).toThrow('Core 尚未就绪')
  })
})
