import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isUserInputMessage } from '@profer/session-core'
import type { SDKMessage } from '@profer/shared'
import { CoreClient, type CoreWebSocket } from './core-client'
import { routePocketSessionToCore } from './pocket-core-session-routing'

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
  reply(data: unknown) { const command = JSON.parse(this.sent.at(-1)!); this.onmessage?.({ data: JSON.stringify({ kind: 'command_result', commandId: command._cmdId, ok: true, data }) }) }
}
const meta = { id: 'local-session', title: 'Core title', createdAt: 1, updatedAt: 2 }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
// 直接执行既有分页纯函数，避免测试重复实现回合边界规则或加载桌面manager副作用。
const manager = readFileSync(new URL('./agent-session-manager.ts', import.meta.url), 'utf8')
const paginationStart = manager.indexOf('export function paginateSDKMessages(')
const paginationEnd = manager.indexOf('\n// ──', paginationStart)
const paginationJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(manager.slice(paginationStart, paginationEnd).replace('export function', 'function'))
const paginateMessages = new Function('isUserInputMessage', `${paginationJs}; return paginateSDKMessages`)(isUserInputMessage) as NonNullable<Parameters<typeof routePocketSessionToCore>[1]['paginateMessages']>

test('Pocket读取Core历史保持完整回合分页和安全投影，详情active不读桌面缓存', async () => {
  const messages = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'PRIVATE_COMMAND' } }] } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'PRIVATE_TOOL_RESULT' }] } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ] as SDKMessage[]
  const requests: string[] = []
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    fetchImpl: async (url, init) => { requests.push(url); expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture' });
      return Response.json(url.endsWith('/detail') ? { session: meta, active: true } : { messages }) } })
  const deps = { getClient: () => client, coreEnabled: () => true, sessionItem: (value: unknown) => value, paginateMessages }
  const latest = await routePocketSessionToCore({ type: 'get_sdk_messages', sessionId: meta.id, targetMessages: 1 }, deps)
  expect(latest).toMatchObject({ ok: true, data: { total: 6, startIndex: 4, endIndex: 5, hasMore: true } })
  const earlier = await routePocketSessionToCore({ type: 'get_sdk_messages', sessionId: meta.id, targetMessages: 1, before: 4 }, deps)
  expect(earlier).toMatchObject({ ok: true, data: { total: 6, startIndex: 0, endIndex: 3, hasMore: false } })
  const full = await routePocketSessionToCore({ type: 'get_sdk_messages', sessionId: meta.id }, deps)
  expect(JSON.stringify(full)).not.toContain('PRIVATE_COMMAND')
  expect(JSON.stringify(full)).not.toContain('PRIVATE_TOOL_RESULT')
  const detail = await routePocketSessionToCore({ type: 'session_detail', sessionId: meta.id }, deps)
  expect(detail).toMatchObject({ ok: true, data: { meta: { id: meta.id, active: true }, messages: expect.any(Array) } })
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_COMMAND')
  expect(requests).toContain(`http://127.0.0.1:1/sessions/${meta.id}/detail`)
  const count = requests.length
  expect(await routePocketSessionToCore({ type: 'get_sdk_messages', sessionId: 'core:other:id' }, deps)).toMatchObject({ ok: false })
  expect(await routePocketSessionToCore({ type: 'get_sdk_messages', sessionId: meta.id, before: 1.5 }, deps)).toMatchObject({ ok: false })
  expect(requests).toHaveLength(count)
})

test('Pocket追加和停止必须等Core确认，保留真实stopped/uuid/记账错误', async () => {
  const socket = new Socket()
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => socket })
  const deps = { getClient: () => client, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  const connected = client.connect(); socket.open(); await connected
  try {
    for (const stopped of [false, true]) {
      let settled = false
      const pending = routePocketSessionToCore({ type: 'stop_agent', sessionId: meta.id }, deps).then(value => { settled = true; return value })
      await tick()
      expect(settled).toBe(false)
      expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'stop_agent', sessionId: meta.id })
      socket.reply({ stopped, sessionId: meta.id })
      expect(await pending).toEqual({ ok: true, data: { stopped, sessionId: meta.id } })
    }
    const pending = routePocketSessionToCore({ type: 'queue_message', sessionId: meta.id, userMessage: 'model prompt', rawUserMessage: 'display', uuid: 'stable-input', interrupt: true }, deps)
    await tick()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'queue_message', sessionId: meta.id, prompt: 'model prompt', rawUserMessage: 'display', uuid: 'stable-input', interrupt: true })
    socket.reply({ messageId: 'stable-input', runId: 'run', taskId: 'task', triggerId: 'trigger', recordingError: 'fixture uncertain persistence' })
    expect(await pending).toMatchObject({ ok: true, data: { accepted: true, uuid: 'stable-input', runId: 'run', recordingError: 'fixture uncertain persistence' } })
    const count = socket.sent.length
    expect(await routePocketSessionToCore({ type: 'queue_message', sessionId: meta.id, userMessage: 'prompt', mentionedSkills: ['unsupported'] }, deps)).toMatchObject({ ok: false })
    expect(socket.sent).toHaveLength(count)
    const disconnected = routePocketSessionToCore({ type: 'stop_agent', sessionId: meta.id }, deps)
    await tick(); client.close()
    expect(await disconnected).toMatchObject({ ok: false })
  } finally { client.close() }
})


test('Pocket新建和草稿只请求Core解析默认配置，缺身份/旧Core/迟到结果不回落', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  let current: CoreClient | null
  let stale = false, supported = true
  const draft = { ...meta, draft: true, channelId: 'core-channel' }
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      if (stale) current = null
      return supported ? Response.json(draft) : Response.json({ error: 'not_found' }, { status: 404 })
    } })
  current = client
  const deps = { getClient: () => current, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  expect(await routePocketSessionToCore({ type: 'create_session', title: 'New', workspaceId: 'owner', permissionMode: 'auto' }, deps))
    .toMatchObject({ ok: true, data: { sessionId: meta.id, draft: true, channelId: 'core-channel' } })
  expect(requests[0]).toEqual({ url: 'http://127.0.0.1:1/sessions/configured', body: { useCoreDefaults: true, title: 'New', workspaceId: 'owner', permissionMode: 'auto' } })
  expect(await routePocketSessionToCore({ type: 'ensure_project_draft_session', workspaceId: 'owner' }, deps)).toMatchObject({ ok: true })
  expect(requests[1]).toEqual({ url: 'http://127.0.0.1:1/project-draft-sessions/configured', body: { workspaceId: 'owner', useCoreDefaults: true } })
  const count = requests.length
  expect(await routePocketSessionToCore({ type: 'ensure_project_draft_session' }, deps)).toMatchObject({ ok: false })
  expect(requests).toHaveLength(count)
  supported = false
  expect(await routePocketSessionToCore({ type: 'create_session' }, deps)).toMatchObject({ ok: false })
  expect(requests).toHaveLength(count + 1)
  supported = true; stale = true
  expect(await routePocketSessionToCore({ type: 'create_session' }, deps)).toMatchObject({ ok: false, error: expect.stringContaining('连接已变化') })
})

test('Pocket文件搜索和读取仅路由本地Core，保留预览形状/MIME/version和迟到隔离', async () => {
  const calls: string[] = []
  let current: CoreClient | null
  let stale = false
  const version = { revision: '1:3', mtimeMs: 1, size: 3, hash: 'fixture-hash' }
  const file = { resolvedPath: '/core/图.png', base64: Buffer.from('abc').toString('base64'), mime: 'image/png', version }
  const search = { entries: [{ name: '图.png', path: '图.png', type: 'file', source: 'session' }], total: 1, sessionEntries: [], workspaceEntries: [] }
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    fetchImpl: async (url, init) => { calls.push(url); expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture' }); if (stale) current = null; return Response.json(url.includes('/files/search?') ? search : file) } })
  current = client
  const deps = { getClient: () => current, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  expect(await routePocketSessionToCore({ type: 'search_workspace_files', sessionId: meta.id, query: '图', limit: 10 }, deps)).toEqual({ ok: true, data: search })
  expect(new URL(calls[0]!).searchParams.get('query')).toBe('图')
  expect(await routePocketSessionToCore({ type: 'resolve_and_read_file', sessionId: meta.id, filePath: '图.png', candidateBasePaths: ['/not-authorized'] }, deps))
    .toEqual({ ok: true, data: { resolvedPath: file.resolvedPath, content: 'abc', version } })
  expect(await routePocketSessionToCore({ type: 'read_file_as_data_url', sessionId: meta.id, filePath: '图.png' }, deps))
    .toEqual({ ok: true, data: { resolvedPath: file.resolvedPath, dataUrl: 'data:image/png;base64,YWJj', version } })
  expect(calls.every(url => !url.includes('not-authorized'))).toBe(true)
  const count = calls.length
  expect(await routePocketSessionToCore({ type: 'read_file_as_data_url', sessionId: 'core:other:id', filePath: '/secret' }, deps)).toMatchObject({ ok: false })
  expect(calls).toHaveLength(count)
  stale = true
  expect(await routePocketSessionToCore({ type: 'read_file_as_data_url', sessionId: meta.id, filePath: '图.png' }, deps)).toMatchObject({ ok: false })
})

test('Pocket会话metadata只走本地Core鉴权PATCH并保留revision，不更新桌面默认设置', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(meta) } })
  const deps = { getClient: () => client, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  for (const [type, input, patch] of [
    ['update_session_model', { channelId: 'core-channel', modelId: 'core-model' }, { channelId: 'core-channel', modelId: 'core-model' }],
    ['update_session_runtime', { runtime: 'pi' }, { agentRuntime: 'pi' }],
    ['update_permission_mode', { mode: 'plan' }, { permissionMode: 'plan' }],
    ['update_session_preset', { presetId: 'code' }, { presetId: 'code' }],
    ['rename_session', { title: ' Renamed ' }, { title: 'Renamed' }],
    ['update_session_thinking_level', { level: null }, { openAIThinkingLevel: null }],
    ['update_session_agent_effort', { effort: 'max' }, { agentEffort: 'max' }],
  ] as const) {
    expect(await routePocketSessionToCore({ type, sessionId: meta.id, expectedRevision: 4, ...input }, deps)).toEqual({ ok: true, data: meta })
    const request = calls.at(-1)!
    expect(request.url).toBe(`http://127.0.0.1:1/sessions/${meta.id}`)
    expect(request.init?.method).toBe('PATCH')
    expect(request.init?.headers).toMatchObject({ authorization: 'Bearer fixture' })
    expect(JSON.parse(String(request.init?.body))).toEqual({ expectedRevision: 4, ...patch })
  }
  expect(await routePocketSessionToCore({ type: 'rename_session', sessionId: 'core:other:id', title: 'Wrong' }, deps)).toMatchObject({ ok: false })
  expect(await routePocketSessionToCore({ type: 'update_session_agent_effort', sessionId: meta.id, effort: 'xhigh' }, deps)).toMatchObject({ ok: false })
  expect(await routePocketSessionToCore({ type: 'update_session_model', sessionId: meta.id, modelId: 'without-channel' }, deps)).toMatchObject({ ok: false })
  expect(calls).toHaveLength(7)
  const failing = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, fetchImpl: async () => { throw new Error('Core unavailable') } })
  expect(await routePocketSessionToCore({ type: 'rename_session', sessionId: meta.id, title: 'Title' }, { ...deps, getClient: () => failing })).toEqual({ ok: false, error: 'Core unavailable' })
  expect(await routePocketSessionToCore({ type: 'rename_session', sessionId: meta.id, title: 'Title' }, { ...deps, getClient: () => null })).toMatchObject({ ok: false })
  expect(await routePocketSessionToCore({ type: 'rename_session' }, { ...deps, getClient: () => null, coreEnabled: () => false })).toBeNull()
  expect(await routePocketSessionToCore({ type: 'ping' }, deps)).toBeNull()
})

test('Pocket显示业务动作由Core原子处理；自动已读的explicit=false不能伪装显式确认', async () => {
  const socket = new Socket()
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => socket })
  const deps = { getClient: () => client, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  const connected = client.connect(); socket.open(); await connected
  try {
    for (const [type, action] of [
      ['toggle_session_pin', { type: 'toggle_pin' }], ['toggle_session_archive', { type: 'toggle_archive' }],
      ['mark_session_unread', { type: 'set_unread', unread: true }], ['mark_session_read', { type: 'set_unread', unread: false, explicit: false }],
    ] as const) {
      const pending = routePocketSessionToCore({ type, sessionId: meta.id, expectedRevision: 5 }, deps)
      await tick()
      expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'session_ui_action', sessionId: meta.id, action, expectedRevision: 5 })
      socket.reply(meta)
      expect(await pending).toEqual({ ok: true, data: meta })
    }
  } finally { client.close() }
})

test('Pocket全局审批快照汇总所属Core；revision冲突取Core版本不读桌面', async () => {
  const socket = new Socket()
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => socket,
    fetchImpl: async (_url, init) => init?.method === 'PATCH' ? Response.json({ error: 'REVISION_CONFLICT: stale' }, { status: 400 }) : Response.json({ sessions: [{ ...meta, revision: 8 }] }) })
  const deps = { getClient: () => client, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  const connected = client.connect(); socket.open(); await connected
  try {
    const aggregate = routePocketSessionToCore({ type: 'get_pending_interactions' }, deps)
    await tick()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'list_pending_requests', sessionId: meta.id })
    socket.reply({ permissions: [{ requestId: 'p', sessionId: meta.id, runId: 'run' }], askUsers: [], exitPlans: [] })
    expect(await aggregate).toEqual({ ok: true, data: { permissions: [{ requestId: 'p', sessionId: meta.id, runId: 'run' }], askUsers: [], exitPlans: [], goalProposals: [] } })
    expect(await routePocketSessionToCore({ type: 'rename_session', sessionId: meta.id, title: 'Title', expectedRevision: 7 }, deps))
      .toMatchObject({ ok: false, conflict: { code: 'REVISION_CONFLICT', expectedRevision: 7, actualRevision: 8, sessionId: meta.id } })
  } finally { client.close() }
})

test('Pocket交互查询和回答保留session/run/request；旧响应或缺身份不能回落桌面审批', async () => {
  const socket = new Socket()
  const client = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false, webSocketFactory: () => socket })
  let current: CoreClient | null = client
  const deps = { getClient: () => current, coreEnabled: () => true, sessionItem: (value: unknown) => value }
  const connected = client.connect(); socket.open(); await connected
  try {
    const pending = routePocketSessionToCore({ type: 'get_pending_interactions', sessionId: meta.id }, deps)
    await tick()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: 'list_pending_requests', sessionId: meta.id })
    const snapshot = { permissions: [], askUsers: [{ sessionId: meta.id, requestId: 'ask', runId: 'run' }], exitPlans: [], goalProposals: [] }
    socket.reply(snapshot)
    expect(await pending).toEqual({ ok: true, data: snapshot })
    const scope = { sessionId: meta.id, requestId: 'request', runId: 'run' }
    for (const [type, extra] of [
      ['respond_permission', { behavior: 'allow', alwaysAllow: true }], ['respond_ask_user', { answers: { Q: 'A' } }], ['respond_exit_plan_mode', { action: 'approve_edit' }],
    ] as const) {
      const response = routePocketSessionToCore({ type, ...scope, ...extra }, deps)
      await tick()
      expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type, ...scope, ...extra })
      socket.reply(false)
      expect(await response).toMatchObject({ ok: false })
    }
    const count = socket.sent.length
    expect(await routePocketSessionToCore({ type: 'respond_permission', sessionId: meta.id, requestId: 'request', behavior: 'allow' }, deps)).toMatchObject({ ok: false })
    expect(socket.sent).toHaveLength(count)
    const accepted = routePocketSessionToCore({ type: 'respond_permission', ...scope, behavior: 'deny' }, deps)
    await tick(); socket.reply(true)
    expect(await accepted).toEqual({ ok: true, data: { sessionId: meta.id } })
    const stale = routePocketSessionToCore({ type: 'get_pending_interactions', sessionId: meta.id }, deps)
    await tick(); current = null; socket.reply(snapshot)
    expect(await stale).toMatchObject({ ok: false, error: expect.stringContaining('连接已变化') })
  } finally { client.close() }
})
