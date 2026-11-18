import { expect, test } from 'bun:test'
import { routePocketSessionToCore } from './pocket-core-session-routing'
import { CoreClient } from './core-client'
import { readFileSync } from 'node:fs'

// 执行Pocket真实switch片段，只模拟边界，不启动Electron/用户Core。
const source = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')
function handler(command: 'list_sessions' | 'delete_session', dependencies: Record<string, unknown>) {
  const start = source.indexOf(`    case '${command}': {`)
  const end = source.indexOf("    case '", start + 12)
  if (start < 0 || end < start) throw new Error('Pocket命令边界不存在')
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`async function run(parsed) { switch (parsed.type) { ${source.slice(start, end)} } }; return run`)
  return new Function(...Object.keys(dependencies), js)(...Object.values(dependencies)) as (parsed: object) => Promise<unknown>
}
const noPagination = () => { throw new Error('当前用例不应分页') }

test('Pocket真实命令入口在legacy switch前交给Core；Core错误绝不进入桌面handler', async () => {
  const start = source.indexOf('  const coreInput =')
  const end = source.indexOf('  switch (type) {', start)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`async function run(parsed) { const type = parsed.type; const context = undefined; ${source.slice(start, end)} throw new Error('legacy reached') }; return run`)
  const core = new CoreClient({ baseUrl: 'http://127.0.0.1:1', token: 'fixture', reconnect: false,
    fetchImpl: async () => Response.json({ id: 'session', title: 'Core title', createdAt: 1, updatedAt: 2 }) })
  const run = new Function('routePocketSessionToCore', 'getLocalCoreClient', 'buildSessionItem', 'paginateSDKMessages', js)(routePocketSessionToCore, () => core, (value: unknown) => value, noPagination) as (input: object) => Promise<unknown>
  expect(await run({ type: 'rename_session', sessionId: 'session', title: 'Core title' })).toMatchObject({ ok: true, data: { title: 'Core title' } })
  expect(await run({ type: 'respond_permission', sessionId: 'session', requestId: 'request', behavior: 'allow' })).toMatchObject({ ok: false })
})

const noDesktop = () => { throw new Error('不得回落桌面队列') }

test('Pocket删除由本地Core确认级联，Core错误不落回桌面', async () => {
  const cleared: string[] = [], published: string[] = []
  const deps = {
    getLocalCoreClient: () => ({ deleteSession: async (id: string) => ({ requestId: 'accepted', sessionIds: ['child', id] }) }),
    requestSessionDeletion: noDesktop,
    remoteAgentReplayRegistry: { clearSession: (id: string) => cleared.push(id) },
    publishSessionDeleted: (id: string) => published.push(id),
  }
  expect(await handler('delete_session', deps)({ type: 'delete_session', sessionId: 'parent' })).toEqual({ ok: true, data: { sessionId: 'parent', requestId: 'accepted', sessionIds: ['child', 'parent'] } })
  expect(cleared).toEqual(['child', 'parent'])
  expect(published).toEqual(['child', 'parent'])
  expect(await handler('delete_session', { ...deps, getLocalCoreClient: () => ({ deleteSession: async () => { throw new Error('Core disconnected') } }) })({ type: 'delete_session', sessionId: 'parent' })).toEqual({ ok: false, error: 'Core disconnected' })
  expect(await handler('delete_session', deps)({ type: 'delete_session', sessionId: 'core:other:parent' })).toMatchObject({ ok: false })
})

test('Pocket关闭Core时保留旧删除，不因桌面选择另一Core删除远程会话', async () => {
  const calls: unknown[] = []
  const result = await handler('delete_session', {
    getLocalCoreClient: () => null,
    requestSessionDeletion: (value: unknown) => calls.push(value),
    remoteAgentReplayRegistry: { clearSession() {} }, publishSessionDeleted() {},
    process: { env: { PROFER_CORE_LOCAL: '0' } },
  })({ type: 'delete_session', sessionId: 'local-session' })
  expect(result).toMatchObject({ ok: true, data: { sessionId: 'local-session' } })
  expect(calls).toEqual([{ sessionId: 'local-session', reason: 'user' }])
})

test('Pocket会话列表取本地Core，过滤归档和无效工作区，不读旧索引', async () => {
  const result = await handler('list_sessions', {
    getLocalCoreClient: () => ({ listSessions: async () => [{ id: 'visible', workspaceId: 'workspace' }, { id: 'archived', archived: true }, { id: 'missing', workspaceId: 'deleted' }] }),
    listAgentWorkspaces: () => [{ id: 'workspace' }], buildSessionItem: (value: unknown) => value, buildSessionList: noDesktop,
  })({ type: 'list_sessions' })
  expect(result).toEqual({ ok: true, data: [{ id: 'visible', workspaceId: 'workspace' }] })
  const unavailable = await handler('list_sessions', { getLocalCoreClient: () => null, process: { env: { PROFER_CORE_LOCAL: '1' } }, buildSessionList: noDesktop })({ type: 'list_sessions' })
  expect(unavailable).toEqual({ ok: false, error: '本地Core未就绪' })
})
