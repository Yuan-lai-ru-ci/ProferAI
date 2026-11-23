import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { CHAT_IPC_CHANNELS as C } from '@profer/shared'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'
import { createClaudeSdkDouble } from '../../../packages/agent-provider-claude/test-hosts/claude-sdk-double'

const waitFor = async (predicate: () => boolean, timeout = 15000) => {
  const end = Date.now() + timeout
  while (!predicate() && Date.now() < end) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}

test('Core owner HTTP登录/默认会话→真实Pi ModelRuntime回环请求，Claude共享账号port，重启登出保留自配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-account-e2e-'))
  const relay = crypto.randomUUID()
  const owner = crypto.randomUUID()
  const requests: Array<{ path: string; auth: string | null; body: unknown }> = []
  const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/v1/auth/login') return Response.json({ accessToken: crypto.randomUUID(), refreshToken: crypto.randomUUID(), relayToken: relay, expiresAt: Date.now() + 3600000, userId: 'synthetic', email: 'synthetic@example.test' })
    if (path === '/v1/account/channels') return Response.json({ channels: [{ id: 'same', name: '官方', provider: 'anthropic', baseUrl: `http://127.0.0.1:${upstream.port}/v1/proxy`, models: [{ id: 'claude-sonnet-4-5', name: 'Claude', enabled: true }] }] })
    if (path.includes('messages')) {
      requests.push({ path, auth: request.headers.get('authorization'), body: await request.json() })
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic success' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({})
  } })
  const sdk = createClaudeSdkDouble()
  const config = { host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), accountServerUrl: `http://127.0.0.1:${upstream.port}` }
  const dependencies = { independent: true, claude: { sdkLoader: async () => sdk.module, spawnProcess: sdk.spawnProcess } }
  let runtime = createCoreAgentRuntime(config, dependencies)
  const server = createCoreServer({ version: 'test', runtime, apiKey: owner })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as AddressInfo).port
  const call = async (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['profer.v1'], { headers: { authorization: `Bearer ${owner}` } })
  const frames: Array<Record<string, any>> = []
  socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    runtime.createChannel({ id: 'same', name: 'owned', provider: 'anthropic', apiKey: crypto.randomUUID(), models: [{ id: 'owned-model', name: 'Owned', enabled: true }] })
    expect(await (await call('/account/operations', { operation: 'login', args: ['synthetic@example.test', 'synthetic'] })).json()).toMatchObject({ result: { success: true } })
    expect(runtime.channels.map(channel => [channel.id, channel.serverManaged])).toEqual([['same', undefined], ['account:same', true]])
    expect(JSON.stringify(await (await call('/channels')).json())).not.toContain(relay)
    runtime.updateChannel('same', { name: 'still-owned' })
    expect(() => runtime.deleteChannel('account:same')).toThrow()
    const workspaceId = runtime.workspaces.createManaged('合成').id
    const created = await call('/sessions/configured', { workspaceId, runtime: 'pi' })
    const session = await created.json() as { id: string; channelId: string; modelId: string }
    expect(session).toMatchObject({ channelId: 'account:same', modelId: 'claude-sonnet-4-5' })
    const sent = await call(`/sessions/${session.id}/messages`, { prompt: 'respond briefly' })
    expect({ status: sent.status, body: await sent.json() }).toMatchObject({ status: 202 })
    await waitFor(() => requests.length > 0)
    await waitFor(() => frames.some(frame => frame.sessionId === session.id && frame.payload?.event?.type === 'run_completed'))
    expect(requests[0]?.auth).toBe(`Bearer ${relay}`)
    expect(requests[0]?.body).toMatchObject({ model: 'claude-sonnet-4-5' })
    expect(JSON.stringify(runtime.sessions.readMessages(session.id))).toContain('synthetic success')
    const conversation = await runtime.chat!.operation(C.CREATE_CONVERSATION, []) as { id: string; channelId: string; modelId: string }
    expect(conversation).toMatchObject({ channelId: 'account:same', modelId: 'claude-sonnet-4-5' })
    const beforeChat = requests.length
    expect(await runtime.chat!.operation(C.SEND_MESSAGE, [{ conversationId: conversation.id, runId: crypto.randomUUID(), userMessage: 'chat synthetic', channelId: conversation.channelId, modelId: conversation.modelId }])).toMatchObject({ accepted: true })
    await waitFor(() => requests.length > beforeChat)
    await waitFor(() => runtime.chat!.snapshot().activeRuns.length === 0)
    expect(requests.at(-1)?.auth).toBe(`Bearer ${relay}`)
    expect(JSON.stringify(await runtime.chat!.operation(C.GET_MESSAGES, [conversation.id]))).toContain('synthetic success')
    const claude = runtime.createConfiguredSession({ workspaceId, runtime: 'claude' })
    const handle = runtime.coordinator.run(runtime.createQuery(claude, 'double only'))
    await waitFor(() => Boolean(sdk.state.options))
    expect(sdk.state.options).toMatchObject({ env: { ANTHROPIC_AUTH_TOKEN: relay }, model: 'claude-sonnet-4-5' })
    await runtime.coordinator.stopAndWait(claude.id)
    await handle.promise
    socket.terminate()
    await closeCoreServer(server)
    await runtime.shutdown()
    runtime = createCoreAgentRuntime(config, dependencies)
    await runtime.accountOperation('status')
    expect(runtime.createConfiguredSession({ workspaceId, runtime: 'pi' })).toMatchObject({ channelId: 'account:same', modelId: 'claude-sonnet-4-5' })
    await runtime.accountOperation('logout')
    expect(runtime.channels.map(channel => channel.id)).toEqual(['same'])
    expect(runtime.listChannelConfigs()[0]?.name).toBe('still-owned')
  } finally {
    socket.terminate(); await closeCoreServer(server); await runtime.shutdown(); sdk.dispose(); upstream.stop(true); await rm(root, { recursive: true, force: true })
  }
}, 45000)
