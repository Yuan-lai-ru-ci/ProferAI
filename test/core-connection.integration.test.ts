import { expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { applyCoreRunStarted, isCurrentAgentStreamCompletion, settleCompletedAgentStreamState } from '../apps/electron/src/renderer/lib/agent-stream-state-cleanup'
import type { AgentStreamState } from '../apps/electron/src/renderer/atoms/agent-atoms'
import { deriveAgentRuntimeDisplay } from '../apps/electron/src/renderer/domains/agent-runtime/agent-runtime-display-policy'
import { projectRemoteRunEvent } from '../apps/electron/src/main/lib/core-run-projection'

// Electron 使用 npm ws；Bun 自带 shim 不执行 Node Agent 的 pin 校验。
const require = createRequire(new URL('../apps/electron/package.json', import.meta.url))
const Ws = require(join(dirname(require.resolve('ws/package.json')), 'index.js')) as typeof import('ws')
mock.module('ws', () => ({ default: Ws, WebSocket: Ws, WebSocketServer: Ws.WebSocketServer }))
const { createPinnedCoreTransport } = await import('../apps/electron/src/main/lib/core-pinned-transport')
const { CoreClient } = await import('../apps/electron/src/main/lib/core-client')
const { consumeCoreInvitation, decodeCoreInvitation, encodeCoreInvitation } = await import('../apps/electron/src/main/lib/core-invitation')
const { CoreConnectionHost } = await import('../apps/core/src/connection-host')
const { createCoreAgentRuntime } = await import('../apps/core/src/runtime')
const { createCoreServer, listenCoreServer, closeCoreServer } = await import('../apps/core/src/server')

test('一次性邀请到双客户端真实 TLS/WS、任务断线恢复、附件、撤销和监听重开的完整路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-pair-client-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: root, workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  const options = { runtime, version: 'fixture', coreId: 'pair-client-core', apiKey: 'isolated-owner' }
  let host = await CoreConnectionHost.open(root, options.coreId, options)
  const server = createCoreServer({ ...options, connectionHandler: host.handleOwner })
  await listenCoreServer(server, '127.0.0.1', 0)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('owner listen failed')
  const owner = new CoreClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: options.apiKey, reconnect: false })
  const clients: InstanceType<typeof CoreClient>[] = []
  let senderTransport: ReturnType<typeof createPinnedCoreTransport> | undefined
  try {
    await owner.setSharing(true)
    const invitation = host.service.invite(['127.0.0.1'])
    expect(decodeCoreInvitation(encodeCoreInvitation(invitation))).toEqual(invitation)
    await expect(consumeCoreInvitation({ ...invitation, pin: { algorithm: 'spki-sha256', value: `sha256/${Buffer.alloc(32).toString('base64')}` } })).rejects.toThrow('身份')
    const first = await consumeCoreInvitation(invitation)
    await expect(consumeCoreInvitation(invitation)).rejects.toThrow('失效')
    const second = await consumeCoreInvitation(host.service.invite(['127.0.0.1']))
    const baseUrl = invitation.endpoints[0]!
    const transport = senderTransport = createPinnedCoreTransport(baseUrl, invitation.pin.value)
    let senderSocket: InstanceType<typeof Ws> | undefined
    let senderOffline = false
    let offlineRetries = 0
    let sends = 0
    let connections = 0
    const disconnected = Promise.withResolvers<void>()
    const recovered = Promise.withResolvers<void>()
    for (const paired of [first, second]) {
      const client = new CoreClient({ baseUrl, token: paired.credential, identityPin: invitation.pin.value, reconnect: false, recoverEvents: true,
        ...(paired === first ? {
          reconnect: true,
          reconnectDelayMs: 100,
          fetchImpl: (url, init) => {
            if (init?.method === 'POST' && new URL(url).pathname.endsWith('/messages')) sends++
            return transport.fetchImpl(url, init)
          },
          webSocketFactory: (url, options) => {
            if (senderOffline) {
              offlineRetries++
              throw new Error('发起端网络不可用')
            }
            const socket = transport.webSocketFactory(url, options)
            if (!(socket instanceof Ws)) throw new Error('预期真实 npm WebSocket')
            senderSocket = socket
            connections++
            return socket
          },
          onStatus: status => {
            if (status === 'closed') disconnected.resolve()
            if (status === 'open' && connections > 1) recovered.resolve()
          },
        } : {}),
      })
      clients.push(client)
      expect((await client.identity()).coreId).toBe(invitation.coreId)
      await client.connect()
    }
    const [a, b] = clients as [InstanceType<typeof CoreClient>, InstanceType<typeof CoreClient>]
    const workspace = await a.createManagedWorkspace('Shared workspace')
    expect((await b.listWorkspaces()).some(value => value.id === workspace.id)).toBe(true)
    const session = await a.createSession({ title: 'Paired session', runtime: 'pi', workspaceId: workspace.id })
    const content = Buffer.from('attachment test\n'.repeat(24_000))
    expect(content.length).toBeGreaterThan(256 * 1024)
    const file = await a.saveAttachment(session.id, 'large.txt', content.toString('base64'))
    expect(Buffer.from((await b.readFile(session.id, file.path)).base64, 'base64')).toEqual(content)
    const namespace = `core:${invitation.coreId}:${session.id}`
    let state: AgentStreamState | undefined
    const getState = () => state
    const started = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const waitFor = async (promise: Promise<void>, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([promise, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 6_000) })]) }
      finally { clearTimeout(timer) }
    }
    const senderStarts: unknown[] = []
    const senderTerminals: unknown[] = []
    const senderStarted = Promise.withResolvers<void>()
    const unsubscribeSender = a.addEventListener(event => {
      if (event.sessionId !== session.id) return
      const projection = projectRemoteRunEvent(event, namespace)
      const payload = projection?.eventPayload as import('@profer/shared').AgentStreamPayload | undefined
      if (payload?.kind === 'profer_event' && payload.event.type === 'runtime_started') {
        senderStarts.push(payload.event.runId)
        senderStarted.resolve()
      }
      if (projection?.completion) senderTerminals.push(projection.completion)
    })
    const unsubscribe = b.addEventListener(event => {
      if (event.sessionId !== session.id) return
      const projection = projectRemoteRunEvent(event, namespace)
      const payload = projection?.eventPayload as import('@profer/shared').AgentStreamPayload | undefined
      if (payload?.kind === 'profer_event' && payload.event.type === 'runtime_started' && payload.event.sessionId === namespace) {
        state = applyCoreRunStarted(state, payload.event)
        started.resolve()
      }
      if (projection?.completion && isCurrentAgentStreamCompletion(state, projection.completion)) {
        state = settleCompletedAgentStreamState(state, false)
        complete.resolve()
      }
    })
    expect(await a.sendMessage(session.id, 'paired offline task')).toMatchObject({ accepted: true, sessionId: session.id })
    await waitFor(senderStarted.promise, '发起端没有收到开始')
    await waitFor(started.promise, '旁观端没有收到开始')
    expect(deriveAgentRuntimeDisplay({ running: getState()?.running === true }).showRunningIndicator).toBe(true)
    // 模拟旁观者刷新窗口后丢失内存状态：获取 Core 权威快照应能恢复正在运行的状态。
    state = undefined
    await b.refreshSnapshot()
    expect(getState()?.running).toBe(true)
    const runId = getState()?.runId
    expect(runId).toBeTruthy()
    expect(senderStarts).toEqual([runId])
    if (!senderSocket) throw new Error('发起端未建立配对 WebSocket')
    senderOffline = true
    senderSocket.terminate() // 不调用 CoreClient.close()：后者会禁用自动重连。
    await waitFor(disconnected.promise, '发起端没有检测到断线')
    expect(runtime.coordinator.isRunning(session.id)).toBe(true)
    await waitFor(complete.promise, '旁观端没有收敛终态')
    expect(a.isConnected).toBe(false)
    expect(offlineRetries).toBeGreaterThan(0)
    expect(senderTerminals).toEqual([])
    const hostMessages = await owner.getMessages(session.id)
    expect(hostMessages.filter(value => (value as { type?: string }).type === 'user')).toHaveLength(1)
    expect(hostMessages).toContainEqual(expect.objectContaining({ type: 'result', subtype: 'success', _provenance: expect.objectContaining({ runId }) }))
    senderOffline = false
    await waitFor(recovered.promise, '发起端没有自动重连并恢复事件')
    expect(connections).toBe(2)
    expect(senderStarts).toEqual([runId])
    expect(senderTerminals).toEqual([expect.objectContaining({ sessionId: namespace, runId, outcomeStatus: 'completed', stoppedByUser: false })])
    expect(sends).toBe(1)
    expect(await a.getMessages(session.id)).toEqual(hostMessages)
    unsubscribeSender()
    unsubscribe()
    expect(deriveAgentRuntimeDisplay({ running: getState()?.running === true }).showRunningIndicator).toBe(false)
    expect(JSON.stringify(await b.getMessages(session.id))).toContain('paired offline task')
    await owner.revokeBinding(first.bindingId)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(a.isConnected).toBe(false)
    expect(b.isConnected).toBe(true)
    await expect(a.listSessions()).rejects.toThrow()
    expect((await b.listSessions()).some(value => value.id === session.id)).toBe(true)
    b.close()
    await host.close()
    host = await CoreConnectionHost.open(root, options.coreId, options)
    await b.connect()
    expect((await b.identity()).coreId).toBe(invitation.coreId)
    expect((await b.listSessions()).some(value => value.id === session.id)).toBe(true)
  } finally {
    for (const client of clients) client.close()
    senderTransport?.close()
    owner.close()
    await host.close()
    await closeCoreServer(server)
    await runtime.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
