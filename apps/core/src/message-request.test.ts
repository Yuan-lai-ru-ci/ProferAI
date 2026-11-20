import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import WebSocket from 'ws'
import { createAgentRunContext, type RuntimeCredential } from '@profer/agent-runtime'
import type { SDKMessage } from '@profer/shared'
import { ModelRuntime, createScriptedTransport, type ScriptedTransport } from '../../../packages/agent-provider-pi/test/pi-scripted-transport'
import type { CoreMessageOptions } from './message-input'
import { createCoreAgentRuntime } from './runtime'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'

// 运行真实 Core/HTTP/WS/Pi SDK，只把模型网络流替换为离线脚本，不使用用户 Key 或数据。
describe('Core 每轮凭据与作者集成', () => {
  test('同一 Core 进程支持配置后首次发送、热换 Key/渠道/模型；并发隔离并持久化真实作者', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-message-request-'))
    const prototype = ModelRuntime.prototype as unknown as Record<string, unknown>
    const originalStream = prototype.stream
    const originalSimple = prototype.streamSimple
    const originalSetKey = ModelRuntime.prototype.setRuntimeApiKey
    const keys: Array<{ provider: string; key: string }> = []
    let transport = createScriptedTransport([{ textChunks: ['first answer'] }])
    const models: Array<{ id: string; baseUrl: string }> = []
    const stream: ScriptedTransport['streamSimple'] = (model, context, options) => {
      models.push({ id: model.id, baseUrl: model.baseUrl })
      return transport.streamSimple(model, context, options)
    }
    prototype.stream = stream
    prototype.streamSimple = stream
    ModelRuntime.prototype.setRuntimeApiKey = async function (...args: Parameters<typeof originalSetKey>) {
      keys.push({ provider: args[0], key: args[1] })
      return originalSetKey.apply(this, args)
    }
    const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces') }
    const runtime = createCoreAgentRuntime(config)
    const server = createCoreServer({ version: 'test', runtime, apiKey: 'host-test-token' })
    const events: unknown[] = []
    let socket: WebSocket | undefined
    const completions: Array<{ sessionId: string; errors?: unknown }> = []
    try {
      await listenCoreServer(server, '127.0.0.1', 0)
      const port = (server.address() as AddressInfo).port
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: 'Bearer host-test-token' } })
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString()) as { sessionId: string; payload?: { kind?: string; event?: { type?: string; resultErrors?: unknown } } }
        events.push(event)
        if (event.payload?.event?.type === 'run_completed') completions.push({ sessionId: event.sessionId, errors: event.payload.event.resultErrors })
      })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
      const sendMessage = (sessionId: string, prompt: string, options: CoreMessageOptions): Promise<void> => new Promise((resolve, reject) => {
        const body = JSON.stringify({ ...options, prompt })
        const req = request({ hostname: '127.0.0.1', port, path: `/sessions/${sessionId}/messages`, method: 'POST',
          headers: { authorization: 'Bearer host-test-token', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, response => {
          let result = ''
          response.on('data', chunk => { result += chunk.toString() })
          response.on('end', () => response.statusCode === 202 ? resolve() : reject(new Error(result)))
        })
        req.on('error', reject)
        req.end(body)
      })
      const credential = (key: string, baseUrl = 'https://api.anthropic.com'): RuntimeCredential => ({
        apiKey: key, baseUrl, provider: 'anthropic', forceBearerAuth: false,
      })
      const options = (sessionId: string, uuid: string, key: string, channelId: string, modelId = 'claude-sonnet-4-5', baseUrl?: string): CoreMessageOptions => ({
        uuid, channelId, modelId, rawUserMessage: `display ${uuid}`, credentials: credential(key, baseUrl),
        context: createAgentRunContext({ sessionId, uuid, initiator: 'user', messageAuthor: { type: 'user' } }, () => crypto.randomUUID()),
      })
      const waitForCompletions = async (count: number): Promise<void> => {
        const deadline = Date.now() + 8000
        while (completions.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        expect(completions).toHaveLength(count)
      }
      // Core 启动时没有任何渠道；旧会话含已删除渠道，当前请求必须覆盖它。
      const old = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'old session', runtime: 'pi', channelId: 'removed-channel', modelId: 'removed-model' })
      const historical: SDKMessage = { type: 'user', uuid: 'historical-without-author', session_id: old.id, parent_tool_use_id: null, message: { role: 'user', content: 'historical input' } }
      runtime.sessions.appendMessages(old.id, [historical])
      const first = options(old.id, 'user-first', 'offline-first-key', 'new-channel')
      await sendMessage(old.id, 'first engine prompt', first)
      await waitForCompletions(1)
      expect(completions[0]?.errors).toBeUndefined()
      expect(keys.at(-1)).toMatchObject({ key: 'offline-first-key' })
      const firstSdkId = runtime.sessions.getMeta(old.id)?.sdkSessionId
      expect(firstSdkId).toBeTruthy()

      // 同一进程、同一原生上下文，在下一次请求更换 Key/地址/渠道/模型。
      transport = createScriptedTransport([{ textChunks: ['second answer'] }])
      const second = options(old.id, 'user-second', 'offline-second-key', 'second-channel', 'claude-sonnet-4-6', 'https://second.test')
      await sendMessage(old.id, 'second engine prompt', second)
      await waitForCompletions(2)
      expect(completions[1]?.errors).toBeUndefined()
      expect(keys.at(-1)).toMatchObject({ key: 'offline-second-key' })
      expect(models.at(-1)).toMatchObject({ id: 'claude-sonnet-4-6', baseUrl: 'https://second.test' })
      expect(runtime.sessions.getMeta(old.id)).toMatchObject({ channelId: 'second-channel', modelId: 'claude-sonnet-4-6', sdkSessionId: firstSdkId })
      const messages = runtime.sessions.readMessages(old.id)
      expect(messages.find(message => 'uuid' in message && message.uuid === 'historical-without-author')?._provenance).toBeUndefined()
      for (const uuid of ['user-first', 'user-second']) {
        const message = messages.find(message => 'uuid' in message && message.uuid === uuid)
        expect(message).toMatchObject({ type: 'user', message: { content: [{ type: 'text', text: `display ${uuid}` }] }, _provenance: { author: { type: 'user' }, messageId: uuid, triggerId: `message:${old.id}:${uuid}` } })
        expect(message?._provenance?.runId).toBeTruthy()
      }
      expect(messages.filter(message => message.type === 'assistant').every(message => message._provenance?.author.type === 'agent')).toBe(true)
      // 事件与历史必须使用同一个源时间，不能在客户端接收或历史重载时重新计时。
      const liveMessages = events.flatMap(event => {
        const frame = event as { payload?: { kind?: string; message?: SDKMessage } }
        return frame.payload?.kind === 'sdk_message' && frame.payload.message ? [frame.payload.message] : []
      })
      for (const uuid of ['user-first', 'user-second']) {
        const user = messages.find(message => 'uuid' in message && message.uuid === uuid)!
        const turn = messages.filter(message => message._provenance?.runId === user._provenance?.runId)
        const times = turn.map(message => (message as SDKMessage & { _createdAt?: number })._createdAt)
        expect(times.every(time => typeof time === 'number' && Number.isFinite(time))).toBe(true)
        expect(times).toEqual([...times].sort((a, b) => a! - b!))
        for (const persisted of turn) {
          const copies = liveMessages.filter(message => message._provenance?.messageId === persisted._provenance?.messageId && message._provenance?.runId === persisted._provenance?.runId)
          expect(copies.length).toBeGreaterThan(0)
          expect(copies.every(message => (message as Record<string, unknown>)._createdAt === (persisted as Record<string, unknown>)._createdAt)).toBe(true)
        }
      }
      // 同一 UUID 不重发模型、不重复落消息。
      transport = createScriptedTransport([])
      const beforeCount = messages.length
      await sendMessage(old.id, 'second engine prompt', second)
      await waitForCompletions(3)
      expect(transport.calls).toHaveLength(0)
      expect(runtime.sessions.readMessages(old.id)).toHaveLength(beforeCount)

      // 并发的两个新会话不能共享凭据；每个 SDK runtime 都拿到自己的 key/model。
      const a = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'a', runtime: 'pi' })
      const b = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'b', runtime: 'pi' })
      transport = createScriptedTransport([{ textChunks: ['concurrent answer a'] }, { textChunks: ['concurrent answer b'] }])
      await Promise.all([
        sendMessage(a.id, 'parallel a', options(a.id, 'uuid-a', 'offline-key-a', 'channel-a')),
        sendMessage(b.id, 'parallel b', options(b.id, 'uuid-b', 'offline-key-b', 'channel-b')),
      ])
      await waitForCompletions(5)
      expect(completions.slice(-2).every(event => event.errors === undefined)).toBe(true)
      expect(keys).toContainEqual({ provider: `profer-anthropic-${a.id}`, key: 'offline-key-a' })
      expect(keys).toContainEqual({ provider: `profer-anthropic-${b.id}`, key: 'offline-key-b' })
      expect(transport.calls).toHaveLength(2)

      // 请求密钥不出现在会话、消息、台账或 WS 广播中；仅保留本轮内存快照。
      const persisted = await Promise.all([
        readFile(join(root, 'agent-sessions.json'), 'utf8'),
        readFile(join(root, 'agent-sessions', `${old.id}.jsonl`), 'utf8'),
        readFile(join(root, 'core-agent-runs.json'), 'utf8'),
      ])
      const publicData = JSON.stringify([events, ...persisted])
      for (const key of ['offline-first-key', 'offline-second-key', 'offline-key-a', 'offline-key-b']) expect(publicData).not.toContain(key)
      const reloaded = createCoreAgentRuntime(config)
      try {
        expect(reloaded.sessions.readMessages(old.id).find(message => 'uuid' in message && message.uuid === 'user-second')?._provenance?.author).toEqual({ type: 'user' })
      } finally { reloaded.dispose() }
    } finally {
      socket?.terminate()
      await closeCoreServer(server)
      runtime.dispose()
      prototype.stream = originalStream
      prototype.streamSimple = originalSimple
      ModelRuntime.prototype.setRuntimeApiKey = originalSetKey
      await rm(root, { recursive: true, force: true })
    }
  }, 25000)

  test('服务端渠道不存在与缺少 Key 使用明确准备失败码，不伪报解密失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-core-credential-errors-'))
    const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'),
      channels: [{ id: 'missing-key', name: 'test', provider: 'anthropic', apiKey: '' }],
    })
    try {
      for (const [channelId, expected] of [['deleted', 'channel_not_found'], ['missing-key', 'api_key_missing']]) {
        const session = runtime.sessions.create({ workspaceId: (runtime.workspaces.list()[0] ?? runtime.workspaces.createManaged('测试工作区')).id, title: 'test', runtime: 'pi', channelId, modelId: 'claude-sonnet-4-5' })
        const failures: unknown[] = []
        const handle = runtime.coordinator.run(runtime.createQuery(session, 'test'), {
          onEvent() {}, onComplete() {}, onError() {}, onPreparationFailure: failure => { failures.push(failure) },
        })
        expect((await handle.promise).status).toBe('failed')
        expect(failures).toEqual([expect.objectContaining({ phase: 'credentials', code: expected })])
        expect(runtime.sessions.readMessages(session.id)).toHaveLength(0)
      }
    } finally {
      runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
