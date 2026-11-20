import { describe, expect, test } from 'bun:test'
import { CoreClient, CoreClientError, createRemoteStopTimeoutSignal, REMOTE_STOP_TIMEOUT_MS, type CoreWebSocket } from './core-client'

class FakeSocket implements CoreWebSocket {
  static latest: FakeSocket | undefined
  readyState = 0
  readonly url: string
  readonly protocols: string[]
  readonly headers: Record<string, string>
  onopen: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []

  constructor(url: string, options: { protocols: string[]; headers: Record<string, string> }) {
    this.url = url
    this.protocols = options.protocols
    this.headers = options.headers
    FakeSocket.latest = this
  }

  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3; this.onclose?.() }
  open(): void { this.readyState = 1; this.onopen?.() }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}

describe('CoreClient', () => {
  test('删除提交Core，权威快照投影墓碑且不复活旧运行', async () => {
    const events: Array<{ payload?: unknown }> = []
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options), onEvent: event => events.push(event) })
    const connecting = client.connect(); const socket = FakeSocket.latest!; socket.open(); await connecting
    const deleting = client.deleteSession('gone')
    await new Promise(resolve => setTimeout(resolve, 1))
    const command = JSON.parse(socket.sent[0]!)
    expect(command).toMatchObject({ type: 'delete_session', sessionId: 'gone' })
    socket.message({ kind: 'command_result', commandId: command._cmdId, ok: true, data: { requestId: 'deletion', sessionIds: ['gone'] } })
    expect(await deleting).toEqual({ requestId: 'deletion', sessionIds: ['gone'] })
    const refreshing = client.refreshSnapshot()
    await new Promise(resolve => setTimeout(resolve, 1))
    const refresh = JSON.parse(socket.sent[1]!)
    socket.message({ kind: 'command_result', commandId: refresh._cmdId, ok: true, data: {
      sessions: [], goals: [], automations: [], delegations: [], pending: [], cursor: 'epoch:1',
      tombstones: [{ sessionId: 'gone', revision: 20 }], runs: [{ id: 'old-run', sessionRef: 'gone', status: 'running', createdAt: 1 }],
    } })
    await refreshing
    expect(events.map(event => event.payload)).toEqual([{ kind: 'session_projection', operation: 'delete', sessionId: 'gone', revision: 20 }])
    client.close()
  })

  test('显示状态命令保留Core会话、业务动作与revision，不使用本机存储', async () => {
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options) })
    const connecting = client.connect(); const socket = FakeSocket.latest!; socket.open(); await connecting
    const operation = client.applySessionUiAction('session', { type: 'toggle_archive' }, 7)
    await new Promise(resolve => setTimeout(resolve, 1))
    const sent = JSON.parse(socket.sent[0]!)
    expect(sent).toMatchObject({ type: 'session_ui_action', sessionId: 'session', action: { type: 'toggle_archive' }, expectedRevision: 7 })
    socket.message({ kind: 'command_result', commandId: sent._cmdId, ok: true, data: { id: 'session', archived: true } })
    expect(await operation).toMatchObject({ id: 'session', archived: true })
    client.close()
  })

  test('工作区事件与Agent流隔离，游标去重且旧socket不可发布', async () => {
    let callbacks = 0, listeners = 0
    const agents: unknown[] = []
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options), onWorkspaceEvent: () => { callbacks++ }, onEvent: event => agents.push(event),
    })
    const unsubscribe = client.addWorkspaceEventListener(() => { listeners++ })
    const connected = client.connect(); const first = FakeSocket.latest!; first.open(); await connected
    first.message({ kind: 'workspace_event', eventId: 'fixture:1', payload: { type: 'changed' } })
    first.message({ kind: 'workspace_event', eventId: 'fixture:1', payload: { type: 'changed' } })
    expect([callbacks, listeners]).toEqual([1, 1])
    expect(agents).toEqual([])
    client.close()
    const reconnected = client.connect(); const current = FakeSocket.latest!; current.open(); await reconnected
    first.message({ kind: 'workspace_event', eventId: 'fixture:2' })
    expect(callbacks).toBe(1)
    current.message({ kind: 'workspace_event', eventId: 'fixture:2' })
    expect([callbacks, listeners]).toEqual([2, 2])
    unsubscribe()
    current.message({ kind: 'workspace_event', eventId: 'fixture:3' })
    expect([callbacks, listeners]).toEqual([3, 2])
    client.close()
  })

  test('工作区刷新在权威快照恢复和无快照重放完成后都发生', async () => {
    let changes = 0
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false, recoverEvents: true,
      webSocketFactory: (url, options) => new FakeSocket(url, options), onWorkspaceEvent: () => { changes++ },
    })
    for (const requiresSnapshot of [true, false]) {
      const connected = client.connect(); const socket = FakeSocket.latest!; socket.open()
      const command = JSON.parse(socket.sent[0]!)
      socket.message({ kind: 'command_result', commandId: command._cmdId, ok: true, data: { requiresSnapshot, latestEventId: 'epoch:7', replayed: 0,
        ...(requiresSnapshot ? { snapshot: { sessions: [], goals: [], automations: [], delegations: [], pending: [], cursor: 'epoch:7' } } : {}) } })
      await connected
      client.close()
    }
    expect(changes).toBe(2)
  })

  test('Automation命令与事件隔离，旧socket迟到关闭/消息不污染重连', async () => {
    const automations: unknown[] = [], agents: unknown[] = []
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options),
      onAutomationEvent: event => automations.push(event), onEvent: event => agents.push(event),
    })
    const first = client.connect(); const old = FakeSocket.latest!; old.open(); await first
    client.close()
    const second = client.connect(); const current = FakeSocket.latest!; current.open(); await second
    old.close(); old.message({ kind: 'automation_event', payload: 'stale' })
    const result = client.automationRequest<boolean>('delete', { id: 'fixture', operationId: 'stable' })
    await new Promise(resolve => setTimeout(resolve, 1))
    const sent = JSON.parse(current.sent[0]!)
    expect(sent).toMatchObject({ type: 'automation_delete', id: 'fixture', operationId: 'stable' })
    current.message({ kind: 'command_result', commandId: sent._cmdId, ok: true, data: true })
    expect(await result).toBe(true)
    current.message({ kind: 'automation_event', payload: 'current' })
    expect(automations).toEqual(['current']); expect(agents).toEqual([])
    client.close()
  })

  test('uses bearer auth for HTTP commands and does not expose the token on health checks', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new CoreClient({
      baseUrl: 'http://127.0.0.1:7790/',
      token: 'secret-token',
      reconnect: false,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
      },
    })

    await client.health()
    await client.listSessions()
    await client.sendMessage('session/1', 'hello')

    expect(calls[0]?.url).toBe('http://127.0.0.1:7790/health')
    expect(calls[0]?.init?.headers).toEqual({})
    expect(calls[1]?.init?.headers).toEqual({ authorization: 'Bearer secret-token' })
    expect(calls[2]?.url).toBe('http://127.0.0.1:7790/sessions/session%2F1/messages')
    expect(calls[2]?.init?.headers).toEqual({ authorization: 'Bearer secret-token', 'content-type': 'application/json' })
    expect(calls[2]?.init?.body).toBe(JSON.stringify({ prompt: 'hello' }))
  })

  test('routes Planning requests and events separately from Agent session events', async () => {
    const received: unknown[] = []
    const agents: unknown[] = []
    let request: RequestInit | undefined
    const client = new CoreClient({
      baseUrl: 'http://127.0.0.1:7790', token: 'planning-test', reconnect: false,
      fetchImpl: async (_url, init) => { request = init; return Response.json({ result: [{ id: 'todo' }] }) },
      webSocketFactory: (url, options) => new FakeSocket(url, options),
      onEvent: event => agents.push(event),
    })
    expect(await client.planningOperation<Array<{ id: string }>>('listTodos', [])).toEqual([{ id: 'todo' }])
    expect(request?.headers).toMatchObject({ authorization: 'Bearer planning-test' })
    expect(JSON.parse(String(request?.body))).toEqual({ operation: 'listTodos', args: [] })
    const unsubscribe = client.addPlanningEventListener(payload => received.push(payload))
    const connecting = client.connect()
    FakeSocket.latest!.open()
    await connecting
    FakeSocket.latest!.message({ kind: 'planning_event', payload: { type: 'changed', resources: ['todos'] } })
    expect(received).toEqual([{ type: 'changed', resources: ['todos'] }])
    expect(agents).toEqual([])
    unsubscribe()
    FakeSocket.latest!.message({ kind: 'planning_event', payload: { type: 'changed', resources: ['tags'] } })
    expect(received).toHaveLength(1)
    client.close()
  })

  test('updates remote session metadata through an authenticated PATCH request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const updated = { id: 'remote-session', title: 'Remote session', channelId: 'channel-1', modelId: 'model-1', presetId: 'standard', codexFastMode: true, openAIThinkingLevel: 'xhigh', agentEffort: 'max' }
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'patch-token',
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(updated) },
    })
    await expect(client.updateSessionMeta('remote/session', { channelId: 'channel-1', modelId: 'model-1', presetId: 'standard', codexFastMode: true, openAIThinkingLevel: 'xhigh', agentEffort: 'max' })).resolves.toEqual(updated)
    expect(calls[0]?.url).toBe('https://core.example.test/sessions/remote%2Fsession')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer patch-token', 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ channelId: 'channel-1', modelId: 'model-1', presetId: 'standard', codexFastMode: true, openAIThinkingLevel: 'xhigh', agentEffort: 'max' })
  })

  test('交互请求查询和响应均保留session/run，不降级为普通权限允许', async () => {
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options),
    })
    const connecting = client.connect()
    const socket = FakeSocket.latest!
    socket.open()
    await connecting
    const scope = { sessionId: 'raw-session', requestId: 'request', runId: 'run' }
    const requests = [
      { pending: () => client.listPendingRequests(scope.sessionId), expected: { type: 'list_pending_requests', sessionId: scope.sessionId }, result: { permissions: [], askUsers: [], exitPlans: [], goalProposals: [] } },
      { pending: () => client.respondAskUser({ ...scope, answers: { Q: 'A' } }), expected: { type: 'respond_ask_user', ...scope, answers: { Q: 'A' } }, result: true },
      { pending: () => client.respondExitPlan({ ...scope, action: 'approve_edit' }), expected: { type: 'respond_exit_plan_mode', ...scope, action: 'approve_edit' }, result: true },
    ]
    try {
      for (const request of requests) {
        const pending = request.pending()
        await new Promise(resolve => setTimeout(resolve, 0))
        const command = JSON.parse(socket.sent.at(-1)!)
        expect(command).toMatchObject(request.expected)
        socket.message({ kind: 'command_result', commandId: command._cmdId, ok: true, data: request.result })
        await expect(pending).resolves.toEqual(request.result)
      }
    } finally { client.close() }
  })

  test('loads authenticated Core identity for compatibility checks', async () => {
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'identity-token',
      fetchImpl: async (_url, init) => {
        expect(init?.headers).toEqual({ authorization: 'Bearer identity-token' })
        return Response.json({ protocolVersion: 1, coreId: 'remote-1', version: '0.1.1', capabilities: ['sessions.read'] })
      },
    })
    await expect(client.identity()).resolves.toEqual({
      protocolVersion: 1, coreId: 'remote-1', version: '0.1.1', capabilities: ['sessions.read'],
    })
  })

  test('重排与项目解绑保持专用鉴权路由，不降级为桌面或通用删除', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let supported = true
    const workspaces = [{ id: 'a', name: 'A', slug: 'a', createdAt: 1, updatedAt: 1 }]
    const client = new CoreClient({ baseUrl: 'https://core.example.test', token: 'workspace-token', reconnect: false,
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return !supported ? Response.json({ error: 'not_found' }, { status: 404 })
        : init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ workspaces }) },
    })
    expect(await client.reorderWorkspaces(['a'])).toEqual(workspaces)
    await client.removeProjectWorkspace('project/id')
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['https://core.example.test/workspaces/reorder', 'POST'], ['https://core.example.test/workspaces/projects/project%2Fid', 'DELETE'],
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ orderedIds: ['a'] })
    for (const call of calls) expect(call.init?.headers).toMatchObject({ authorization: 'Bearer workspace-token' })
    supported = false
    await expect(client.reorderWorkspaces(['a'])).rejects.toMatchObject({ status: 404 })
    await expect(client.removeProjectWorkspace('a')).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(4)
  })

  test('项目重新定位只发送鉴权Core请求，不在旧Core失败时回退绑定新项目', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let ok = true
    const result = { workspace: { id: 'same', slug: 'same', rootPath: '/moved' }, created: false, warnings: [] }
    const client = new CoreClient({ baseUrl: 'https://core.example.test', token: 'fixture', reconnect: false,
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return ok ? Response.json(result) : Response.json({ error: 'not_found' }, { status: 404 }) } })
    expect(await client.relocateProjectWorkspace({ id: 'same', rootPath: '/moved' })).toMatchObject(result)
    expect(calls[0]?.url).toBe('https://core.example.test/workspaces/projects/relocate')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer fixture' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: 'same', rootPath: '/moved' })
    ok = false
    await expect(client.relocateProjectWorkspace({ id: 'same', rootPath: '/moved' })).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(2)
  })

  test('updates and deletes workspaces through authenticated Core HTTP', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new CoreClient({ baseUrl: 'https://core.example.test', token: 'workspace-token', fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init }); return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'workspace-1', name: 'Renamed', archived: true })
    } })
    await expect(client.updateWorkspace('workspace-1', { name: 'Renamed', archived: true })).resolves.toMatchObject({ id: 'workspace-1', archived: true })
    await expect(client.deleteWorkspace('workspace-1')).resolves.toBeUndefined()
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['https://core.example.test/workspaces/workspace-1', 'PATCH'],
      ['https://core.example.test/workspaces/workspace-1', 'DELETE'],
    ])
    for (const call of calls) expect(call.init?.headers).toMatchObject({ authorization: 'Bearer workspace-token' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: 'Renamed', archived: true })
  })

  test('routes workspace operations through authenticated Core HTTP requests', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'workspace-token',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init })
        if (String(url).endsWith('/workspaces')) return Response.json({ workspaces: [] })
        if (String(url).endsWith('/workspaces/projects')) return Response.json({ workspace: { id: 'w1' }, created: true, warnings: [] }, { status: 201 })
        return Response.json({ id: 'w1', name: 'managed' }, { status: 201 })
      },
    })
    await client.listWorkspaces()
    await client.createManagedWorkspace('managed')
    await client.bindProjectWorkspace({ rootPath: '/home/profer/repo', open: true })
    expect(calls.map(call => call.url)).toEqual([
      'https://core.example.test/workspaces',
      'https://core.example.test/workspaces',
      'https://core.example.test/workspaces/projects',
    ])
    for (const call of calls) expect(call.init?.headers).toMatchObject({ authorization: 'Bearer workspace-token' })
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ rootPath: '/home/profer/repo', open: true })
  })

  test('项目草稿请求鉴权且旧Core不降级为普通会话', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let supported = true
    const draft = { id: 'draft', title: 'Draft', workspaceId: 'owner', draft: true }
    const client = new CoreClient({ baseUrl: 'https://core.example.test', token: 'draft-token', reconnect: false,
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return supported ? Response.json(draft) : Response.json({ error: 'not_found' }, { status: 404 }) },
    })
    expect(await client.ensureProjectDraftSession({ workspaceId: 'owner', channelId: 'channel', modelId: 'model' })).toEqual(draft)
    expect(calls[0]?.url).toBe('https://core.example.test/project-draft-sessions')
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer draft-token', 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ workspaceId: 'owner', channelId: 'channel', modelId: 'model' })
    supported = false
    await expect(client.ensureProjectDraftSession({ workspaceId: 'owner' })).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url.endsWith('/project-draft-sessions') && call.init?.method === 'POST')).toBe(true)
  })

  test('ensures a workspace session atomically and returns the remote session metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const session = { id: 'session-1', title: 'New session', agentRuntime: 'pi', workspaceId: 'workspace-1', channelId: 'channel-1', modelId: 'model-1' }
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'workspace-token',
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(session) },
    })

    await expect(client.ensureWorkspaceSession({ workspaceId: 'workspace-1', channelId: 'channel-1', modelId: 'model-1' })).resolves.toEqual(session)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://core.example.test/workspace-sessions')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer workspace-token', 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ workspaceId: 'workspace-1', channelId: 'channel-1', modelId: 'model-1' })
  })

  test('requires a newer Core instead of creating a session outside the selected workspace', async () => {
    const calls: string[] = []
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'legacy-token', reconnect: false,
      fetchImpl: async (url, init) => {
        calls.push(`${String(url)}:${init?.method ?? 'GET'}`)
        if (String(url).endsWith('/workspace-sessions')) return Response.json({ error: 'not_found' }, { status: 404 })
        return Response.json({ sessions: [] })
      },
    })

    await expect(client.ensureWorkspaceSession({ workspaceId: 'workspace-1' })).rejects.toMatchObject({
      code: 'core_version_unsupported',
    })
    expect(calls).toEqual([
      'https://core.example.test/workspace-sessions:POST',
      'https://core.example.test/sessions:GET',
    ])
  })

  test('reuses a workspace-owned session on legacy Core without creating a duplicate', async () => {
    const existing = { id: 'workspace-session', title: 'Existing', workspaceId: 'workspace-1', agentRuntime: 'pi' }
    const calls: string[] = []
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'legacy-token', reconnect: false,
      fetchImpl: async (url) => {
        calls.push(String(url))
        return String(url).endsWith('/workspace-sessions')
          ? Response.json({ error: 'not_found' }, { status: 404 })
          : Response.json({ sessions: [existing] })
      },
    })

    await expect(client.ensureWorkspaceSession({ workspaceId: 'workspace-1' })).resolves.toEqual(existing)
    expect(calls).toEqual([
      'https://core.example.test/workspace-sessions',
      'https://core.example.test/sessions',
    ])
  })

  test('creates a session through the legacy authenticated WebSocket command when the HTTP route is unavailable', async () => {
    let socket: FakeSocket | undefined
    const created = { id: 'legacy-ws-session', title: 'New session', agentRuntime: 'pi' }
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'legacy-token', reconnect: false,
      fetchImpl: async () => Response.json({ error: 'not_found' }, { status: 404 }),
      webSocketFactory: (url, options) => { socket = new FakeSocket(url, options); return socket },
    })
    const pending = client.createSession({ title: 'New session', runtime: 'pi' })
    for (let wait = 0; !socket || !socket.onopen; wait++) {
      if (wait > 100) throw new Error('WebSocket open handler was not installed')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    socket.open()
    for (let wait = 0; socket.sent.length === 0; wait++) {
      if (wait > 100) throw new Error('Legacy create command was not sent')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const command = JSON.parse(socket.sent[0] ?? '{}') as { _cmdId?: string; type?: string }
    expect(command.type).toBe('create_session')
    socket.message({ kind: 'command_result', commandId: command._cmdId, ok: true, data: created })
    await expect(pending).resolves.toEqual(created)
    client.close()
  })

  test('does not create an unbound legacy session when the workspace ensure route is unavailable', async () => {
    const calls: string[] = []
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'legacy-token', reconnect: false,
      fetchImpl: async (url) => {
        calls.push(String(url))
        return String(url).endsWith('/workspace-sessions')
          ? Response.json({ error: 'not_found' }, { status: 404 })
          : Response.json({ sessions: [] })
      },
    })

    await expect(client.ensureWorkspaceSession({ workspaceId: 'missing' })).rejects.toMatchObject({
      message: '远程 Core 版本过旧，无法在指定工作区创建会话。请更新服务器上的 Profer Core 后重试。',
      code: 'core_version_unsupported',
    })
    expect(calls).toEqual([
      'https://core.example.test/workspace-sessions',
      'https://core.example.test/sessions',
    ])
  })

  test('每轮参数只随鉴权发送请求传递，不混入会话创建/其他请求', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'test-host-token',
      fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ accepted: true }) },
    })

    const options = {
      channelId: 'selected', modelId: 'model', uuid: 'user-uuid', rawUserMessage: 'display',
      credentials: { apiKey: 'request-only-key', provider: 'anthropic' as const, baseUrl: 'https://example.test', forceBearerAuth: false },
    }
    await client.sendMessage('session-1', 'engineered prompt', options)
    await client.listSessions()
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer test-host-token', 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ...options, prompt: 'engineered prompt' })
    expect(calls[1]?.init?.body).toBeUndefined()
  })

  test('发送内部连接等待结束后复核目标，过期请求不bind也不HTTP发送', async () => {
    let current = true
    const requests: string[] = []
    const client = new CoreClient({ baseUrl: 'http://127.0.0.1:7790', token: 'fixture', reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options),
      fetchImpl: async url => { requests.push(String(url)); return Response.json({ accepted: true, sessionId: 'session' }) },
    })
    client.setHostRequestHandler(async request => ({ coreId: request.coreId, sessionId: request.sessionId,
      runId: request.runId, requestId: request.requestId, ok: true, value: null }))
    const sending = client.sendMessage('session', 'fixture', {}, () => { if (!current) throw new Error('Core已切换') })
    const socket = FakeSocket.latest!
    current = false
    socket.open()
    await expect(sending).rejects.toThrow('Core已切换')
    expect(requests).toEqual([])
    expect(socket.sent.map(line => JSON.parse(line).type)).not.toContain('bind_desktop_host')
    const registration = socket.sent.map(line => JSON.parse(line)).find(command => command.type === 'register_desktop_host')
    if (registration) socket.message({ kind: 'command_result', commandId: registration._cmdId, ok: true, data: true })
    client.close()
  })

  test('connects with bearer auth in the websocket header, forwards events, and stops reconnecting after close', async () => {
    const events: unknown[] = []
    const statuses: string[] = []
    const client = new CoreClient({
      baseUrl: 'http://127.0.0.1:7790',
      token: 'secret-token',
      reconnect: false,
      webSocketFactory: (url, options) => new FakeSocket(url, options),
      onEvent: event => events.push(event),
      onStatus: status => statuses.push(status),
    })

    const connecting = client.connect()
    const socket = FakeSocket.latest
    expect(socket?.url).toBe('ws://127.0.0.1:7790/ws')
    expect(socket?.protocols).toEqual(['profer.v1'])
    expect(socket?.headers).toEqual({ authorization: 'Bearer secret-token' })
    socket?.open()
    await connecting
    socket?.message({ kind: 'hello', serverTime: 1 })
    socket?.message({ kind: 'agent_event', sessionId: 'session-1', payload: { kind: 'sdk_message' } })
    expect(events).toHaveLength(1)
    expect(statuses).toEqual(['connecting', 'open'])

    client.close()
    expect(statuses.at(-1)).toBe('closed')
  })

  test('bounds remote stop requests with an abort signal', async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = []
    const client = new CoreClient({
      baseUrl: 'https://core.example.test', token: 'stop-token',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), signal: init?.signal as AbortSignal | undefined })
        return Response.json({ stopped: true, sessionId: 'session-1' })
      },
    })
    await expect(client.stop('session-1')).resolves.toEqual({ stopped: true, sessionId: 'session-1' })
    expect(calls[0]?.url).toBe('https://core.example.test/sessions/session-1/stop')
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(REMOTE_STOP_TIMEOUT_MS).toBe(30_000)
  })

  test('surfaces Core protocol errors with status and error code', async () => {
    const client = new CoreClient({
      baseUrl: 'http://127.0.0.1:7790',
      token: 'secret-token',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'unauthorized', code: 'AUTH_FAILED' }), { status: 401 }),
    })

    await expect(client.listSessions()).rejects.toBeInstanceOf(CoreClientError)
    try { await client.listSessions() } catch (error) {
      expect(error).toMatchObject({ status: 401, code: 'AUTH_FAILED', message: 'unauthorized' })
    }
  })
})
