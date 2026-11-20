import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { CHAT_IPC_CHANNELS as C } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createCoreChat } from './chat'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'

describe('Core Chat HTTP / WS', () => {
  test('Given 鉴权Core When CRUD/发送/事件恢复 Then Chat协议隔离且超限拒绝', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'core-chat-http-'))
    const runtime = createCoreAgentRuntime({ configDir, host: '127.0.0.1', port: 0, workspaceRoot: join(configDir, 'workspaces'), mockAgent: true, channels: [{ id: 'mock', name: 'Mock', provider: 'openai', baseUrl: 'https://mock.invalid/v1', apiKey: 'test', models: [{ id: 'model', name: 'Model', enabled: true }] }] })
    const originalChat = runtime.chat
    runtime.chat = createCoreChat({ configDir, listChannels: () => runtime.listChannelConfigs(), emit: (sessionId, channel, payload) => runtime.publish({ type: 'chat', sessionId, payload: { channel, payload } }), fetch: (async (_url: unknown, init?: RequestInit) => { if (!JSON.parse(String(init?.body)).stream) return Response.json({ choices: [{ message: { content: 'Mock title' } }] }); return new Response('data: {"choices":[{"delta":{"content":"mock reply"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }) as unknown as typeof globalThis.fetch })
    const server = createCoreServer({ runtime, version: 'test', apiKey: 'secret' })
    await listenCoreServer(server, '127.0.0.1', 0)
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    const call = (operation: string, args: unknown[], auth = true) => fetch(`${base}/chat/operations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer secret' } : {}) }, body: JSON.stringify({ operation, args }) })
    const frames: Array<Record<string, unknown>> = []
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`)
    ws.on('message', raw => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      expect((await call(C.LIST_CONVERSATIONS, [], false)).status).toBe(401)
      expect((await (await fetch(`${base}/identity`, { headers: { authorization: 'Bearer secret' } })).json() as { capabilities: string[] }).capabilities).toContain('chat')
      const created = await (await call(C.CREATE_CONVERSATION, [null, 'model', 'mock'])).json() as { result: { id: string } }
      const id = created.result.id
      expect((created.result as { title?: string }).title).toBe('新对话')
      const empty = await (await call(C.CREATE_CONVERSATION, ['', 'model', 'mock'])).json() as { result: { title: string } }
      expect(empty.result.title).toBe('新对话')
      expect((await call(C.UPDATE_TITLE, [id, null])).status).toBe(400)
      expect((await call(C.UPDATE_TITLE, [id, ''])).status).toBe(200)
      expect((await call(C.SEND_MESSAGE, [{ conversationId: id, runId: 'http-run', userMessage: '请分析这个完整的模拟测试请求并概括主题', messageHistory: [], channelId: 'mock', modelId: 'model' }])).status).toBe(200)
      for (let i = 0; i < 100 && !frames.some(frame => frame.channel === C.STREAM_COMPLETE); i++) await Bun.sleep(10)
      const regen = await call(C.REGENERATE_TITLE, [id, null, null])
      expect(regen.status).toBe(200)
      const complete = frames.find(frame => frame.channel === C.STREAM_COMPLETE)
      expect(complete).toMatchObject({ kind: 'chat_event', conversationId: id, payload: { conversationId: id, runId: 'http-run' } })
      expect(typeof complete?.eventId).toBe('string')
      ws.send(JSON.stringify({ type: 'core_snapshot', _cmdId: 'snapshot' }))
      for (let i = 0; i < 100 && !frames.some(frame => frame._cmdId === 'snapshot' || frame.requestId === 'snapshot'); i++) await Bun.sleep(5)
      const snapshot = frames.find(frame => frame.requestId === 'snapshot')?.data as { chat: { conversations: Array<{ id: string }>; activeRuns: unknown[] } }
      expect(snapshot.chat.conversations.some(meta => meta.id === id)).toBe(true)
      expect(snapshot.chat.activeRuns).toEqual([])
      ws.send(JSON.stringify({ type: 'resume_agent_events', cursor: 'invalid-cursor', _cmdId: 'resume' }))
      await Bun.sleep(20)
      const recovery = frames.find(frame => frame.requestId === 'resume')?.data as { requiresSnapshot: boolean; snapshot: { chat: { conversations: Array<{ id: string }> } } }
      expect(recovery.requiresSnapshot).toBe(true)
      expect(recovery.snapshot.chat.conversations.some(meta => meta.id === id)).toBe(true)
      const cursor = frames.find(frame => frame.channel === C.STREAM_USER)?.eventId
      ws.send(JSON.stringify({ type: 'resume_agent_events', cursor, _cmdId: 'replay' }))
      await Bun.sleep(20)
      expect(frames.some(frame => frame.kind === 'chat_event' && frame.replay === true && frame.channel === C.STREAM_COMPLETE)).toBe(true)
      expect((await call('__proto__', [])).status).toBe(400)
      expect((await call(C.READ_ATTACHMENT, ['/etc/passwd'])).status).toBe(400)
      const huge = await fetch(`${base}/chat/operations`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ operation: C.CREATE_CONVERSATION, args: ['x'.repeat(15 * 1024 * 1024)] }) })
      expect(huge.status).toBe(413)
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`)
      const unauthorized = await new Promise<string>(resolve => { rejected.once('unexpected-response', (_request, response) => { response.resume(); rejected.terminate(); resolve(String(response.statusCode)) }); rejected.once('error', () => {}) })
      expect(unauthorized).toBe('401')
    } finally {
      ws.terminate(); await runtime.chat.shutdown(); runtime.chat = originalChat
      await closeCoreServer(server); await runtime.shutdown(); rmSync(configDir, { recursive: true, force: true })
    }
  }, 20000)
})
