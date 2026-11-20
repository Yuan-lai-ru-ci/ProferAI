import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { canSelectAgentSessionRuntime, normalizeAgentRuntime, isAgentRuntime, AGENT_SESSION_RUNTIME_LOCKED_MESSAGE, type AgentRuntime, type AgentSessionMeta } from '@profer/shared'

// 编译真实 handler 段，注入持久化/IPC 边界；不启动 Electron/WS、不访问用户配置。
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
function compile<T>(source: string, symbol: string, deps: Record<string, unknown>): T {
  return new Function(...Object.keys(deps), `${transpiler.transformSync(source)}\nreturn ${symbol}`)(...Object.values(deps)) as T
}
const ipcSource = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')
const ipcStart = ipcSource.indexOf('  // 首次发送前选择 runtime')
const ipcBlock = ipcSource.slice(ipcStart, ipcSource.indexOf('  // ===== 工作区记忆文件管理', ipcStart))
const remoteSource = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')
const remoteStart = remoteSource.indexOf("    case 'update_session_runtime':")
const remoteBlock = remoteSource.slice(remoteStart, remoteSource.indexOf("    case 'update_permission_mode':", remoteStart))

type Handler = (event: unknown, id: string, runtime: unknown) => Promise<AgentSessionMeta>
function fixture(meta: AgentSessionMeta, active = false, settingsFail = false) {
  let session = { ...meta }
  const writes: unknown[] = []
  const projections: AgentSessionMeta[] = []
  const deps = {
    normalizeAgentRuntime, isAgentRuntime, canSelectAgentSessionRuntime, AGENT_SESSION_RUNTIME_LOCKED_MESSAGE,
    assertSensitiveAgentIpcSender() {},
    routeSessionMetaToCore: async () => null,
    getAgentSessionMeta: (id: string) => id === session.id ? session : undefined,
    isAgentSessionActive: () => active,
    snapshotAgentRuntimeMeta: () => ({ ...session }),
    updateAgentSessionMeta: (_id: string, patch: Partial<AgentSessionMeta>) => {
      writes.push(patch)
      session = { ...session, ...patch, revision: (session.revision ?? 0) + 1 }
      return session
    },
    restoreAgentRuntimeMeta: (_id: string, previous: AgentSessionMeta) => {
      session = { ...previous, revision: (session.revision ?? 0) + 1 }
      return session
    },
    updateSettings: (patch: unknown) => { writes.push(patch); if (settingsFail) throw new Error('settings failed') },
    publishAgentSessionProjection: (meta: AgentSessionMeta) => projections.push(meta),
    validateExpectedRevision: (parsed: Record<string, unknown>) => parsed.expectedRevision !== undefined && parsed.expectedRevision !== session.revision
      ? { ok: false, error: 'revision conflict' } : undefined,
    buildSessionItem: (meta: AgentSessionMeta) => ({ ...meta, agentRuntimeLocked: !canSelectAgentSessionRuntime(meta) }),
    updateAgentSessionUiMeta: (_id: string, patch: Partial<AgentSessionMeta>) => {
      writes.push(patch); session = { ...session, ...patch, revision: (session.revision ?? 0) + 1 }; projections.push(session); return session
    },
  }
  let handler!: Handler
  compile<void>(ipcBlock, 'undefined', { ...deps, AGENT_IPC_CHANNELS: { UPDATE_SESSION_AGENT_RUNTIME: 'select-runtime' }, ipcMain: { handle: (_name: string, fn: Handler) => { handler = fn } } })
  const remote = compile<(parsed: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: AgentSessionMeta }>>(`async function remote(parsed) { switch(parsed.type) { ${remoteBlock} } }`, 'remote', deps)
  return { ipc: handler, remote: (runtime: unknown, extra = {}) => remote({ type: 'update_session_runtime', sessionId: session.id, runtime, ...extra }), writes, projections, session: () => session }
}
const meta = (runtime: AgentRuntime, extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta => ({ id: 'session', title: 'history', agentRuntime: runtime, createdAt: 1, updatedAt: 1, ...extra })

describe('桌面 IPC / Pocket 会话内核绑定', () => {
  test.each(['claude', 'pi'] as const)('%s 旧会话切换双方均拒绝，无存储/设置/投影副作用', async (runtime) => {
    for (const extra of [{}, { agentRuntimeLocked: true }, { draft: true, sdkSessionId: 'native' }]) {
      const f = fixture(meta(runtime, extra))
      const other = runtime === 'pi' ? 'claude' : 'pi'
      await expect(f.ipc({}, 'session', other)).rejects.toThrow('内核已固定')
      expect(await f.remote(other)).toMatchObject({ ok: false, error: AGENT_SESSION_RUNTIME_LOCKED_MESSAGE })
      expect(f.writes).toEqual([])
      expect(f.projections).toEqual([])
      expect(f.session()).toEqual(meta(runtime, extra))
    }
  })
  test('已有 Pi 会话重复选择 Pi 幂等，不修改默认内核或 revision', async () => {
    const f = fixture(meta('pi', { revision: 7, agentRuntimeLocked: true }), true)
    expect(await f.ipc({}, 'session', 'pi')).toMatchObject({ revision: 7, agentRuntime: 'pi' })
    expect(await f.remote('pi')).toMatchObject({ ok: true, data: { agentRuntimeLocked: true } })
    expect(f.writes).toEqual([])
  })
  test.each(['claude', 'pi'] as const)('%s 新会话两种入口仍可选另一内核，正在运行时拒绝', async (runtime) => {
    const other = runtime === 'pi' ? 'claude' : 'pi'
    const f = fixture(meta(runtime, { agentRuntimeLocked: false }))
    expect(await f.ipc({}, 'session', other)).toMatchObject({ agentRuntime: other, agentRuntimeLocked: false })
    expect(f.projections).toHaveLength(1)
    const remote = fixture(meta(runtime, { agentRuntimeLocked: false }))
    expect(await remote.remote(other)).toMatchObject({ ok: true, data: { agentRuntime: other, agentRuntimeLocked: false } })
    const busy = fixture(meta(runtime, { agentRuntimeLocked: false }), true)
    await expect(busy.ipc({}, 'session', other)).rejects.toThrow('已开始运行')
    expect(await busy.remote(other)).toMatchObject({ ok: false })
    expect(busy.writes).toEqual([])
  })
  test('设置失败回滚空会话，发布比选择更新的 revision；Pocket 过期请求不写入', async () => {
    const f = fixture(meta('claude', { agentRuntimeLocked: false, revision: 2 }), false, true)
    await expect(f.ipc({}, 'session', 'pi')).rejects.toThrow('settings failed')
    expect(f.session()).toMatchObject({ agentRuntime: 'claude', revision: 4, agentRuntimeLocked: false })
    expect(f.projections).toHaveLength(1)
    const remote = fixture(meta('pi', { agentRuntimeLocked: false, revision: 3 }))
    expect(await remote.remote('claude', { expectedRevision: 2 })).toMatchObject({ ok: false, error: 'revision conflict' })
    expect(remote.writes).toEqual([])
  })
  test('非法内核和会话标识被拒绝', async () => {
    const f = fixture(meta('pi', { agentRuntimeLocked: false }))
    await expect(f.ipc({}, 'session', 'unknown')).rejects.toThrow('无效')
    await expect(f.ipc({}, '', 'claude')).rejects.toThrow('标识无效')
    expect(await f.remote('unknown')).toMatchObject({ ok: false })
    expect(f.writes).toEqual([])
  })
})
