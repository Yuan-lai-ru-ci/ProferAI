import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, isAgentRuntime, isProferPermissionMode, buildAgentSessionUiProjection } from '@profer/shared'
import { projectRemoteRunEvent } from './core-run-projection'

// 执行实际注册代码，避免测试里重复实现 Core/桌面分支。
const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function handler(channel: string, dependencies: Record<string, unknown>) {
  const group = channel.startsWith('PRESET:') ? 'AGENT_PRESET_IPC_CHANNELS' : 'AGENT_IPC_CHANNELS'
  const name = channel.replace(/^PRESET:/, '')
  const marker = `  ipcMain.handle(\n    ${group}.${name},`
  const inlineMarker = `  ipcMain.handle(${group}.${name},`
  const start = Math.max(source.indexOf(marker), source.indexOf(inlineMarker))
  const inline = group === 'AGENT_PRESET_IPC_CHANNELS' && source.indexOf(inlineMarker) >= 0
  const end = inline ? source.indexOf('\n  })', start) : source.indexOf('\n  )', start)
  if (start < 0 || end < start) throw new Error(`IPC 注册边界不存在：${channel}`)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + (inline ? 5 : 4)))
  let invoke: ((...args: unknown[]) => Promise<unknown>) | undefined
  const deps = {
    AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, isAgentRuntime, isProferPermissionMode,
    isLocalCoreEnabled: () => false,
    getCurrentCoreTargetId: () => 'local',
    getCoreTargetGeneration: () => 1,
    assertSensitiveAgentIpcSender: () => {},
    assertLocalCoreTarget: () => {},
    localCoreNotReadyMessage: () => '本机Core尚未就绪',
    isAgentSessionActive: () => false,
    getSettings: () => ({ agentRuntime: 'claude' }),
    ...dependencies,
    ipcMain: { handle: (_name: string, callback: typeof invoke) => { invoke = callback } },
  }
  new Function(...Object.keys(deps), js)(...Object.values(deps))
  if (!invoke) throw new Error(`IPC 未注册：${channel}`)
  return (...args: unknown[]) => invoke!({}, ...args)
}

const session = { id: 'core-session', title: 'Core', agentRuntime: 'claude', createdAt: 1, updatedAt: 1 }
const noDesktop = () => { throw new Error('不应访问桌面存储') }

describe('本机 Core 会话 IPC 归属', () => {
  test('首次 Core 启动由 Core 创建默认工作区，IPC 不再写 legacy 索引', () => {
    const start = source.indexOf('  // Core 模式由持锁的 Core 初始化默认工作区')
    const end = source.indexOf('  // 上次退出/崩溃前已接受', start)
    expect(start).toBeGreaterThan(0)
    const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
    let calls = 0
    const initialize = new Function('isLocalCoreEnabled', 'ensureDefaultWorkspace', script)
    initialize(() => true, () => { calls++ })
    expect(calls).toBe(0)
    initialize(() => false, () => { calls++ })
    expect(calls).toBe(1)
  })

  test('本机工作区读写全部路由Core，不回退桌面manager', async () => {
    const calls: string[] = []
    const workspace = { id: 'w1', name: 'Core workspace' }
    const client = {
      listWorkspaces: async () => { calls.push('list'); return [workspace] },
      createManagedWorkspace: async (name: string) => { calls.push(`create:${name}`); return workspace },
      updateWorkspace: async (id: string, updates: unknown) => { calls.push(`update:${id}`); return { ...workspace, updates } },
      deleteWorkspace: async (id: string) => { calls.push(`delete:${id}`) },
      reorderWorkspaces: async (ids: string[]) => { calls.push(`reorder:${ids.join(',')}`); return [workspace] },
      bindProjectWorkspace: async () => { calls.push('bind'); return { workspace, created: true, warnings: [] } },
      removeProjectWorkspace: async (id: string) => { calls.push(`unbind:${id}`) },
      relocateProjectWorkspace: async () => { calls.push('relocate'); return { workspace, created: false, warnings: [] } },
    }
    const deps = { getLocalCoreClient: () => client, getActiveCoreClient: () => client, getCoreTargetGeneration: () => 1,
      getAgentWorkspace: noDesktop, listAgentWorkspaces: noDesktop, createAgentWorkspace: noDesktop, updateAgentWorkspace: noDesktop,
      deleteAgentWorkspace: noDesktop, reorderAgentWorkspaces: noDesktop, openProjectWorkspace: noDesktop,
      createProjectWorkspace: noDesktop, removeProjectWorkspace: noDesktop, relocateProjectWorkspace: noDesktop,
      scheduleProjectSessionMigration: () => Promise.resolve(), ensureProjectSessionPortability: () => Promise.resolve(),
      reconcileProjectSessionIndexesSafely: () => {},
      app: { getVersion: () => 'fixture' }, broadcastAgentWorkspacesChanged: () => {} }
    await expect(handler('LIST_WORKSPACES', deps)()).resolves.toEqual([workspace])
    await handler('CREATE_WORKSPACE', deps)('new')
    await handler('UPDATE_WORKSPACE', deps)('w1', { name: 'Renamed' })
    await handler('REORDER_WORKSPACES', deps)(['w1'])
    await handler('DELETE_WORKSPACE', deps)('w1')
    await handler('CREATE_PROJECT_WORKSPACE', deps)({ rootPath: '/fixture' })
    await handler('OPEN_PROJECT_WORKSPACE', deps)({ rootPath: '/fixture', open: true })
    await handler('REMOVE_PROJECT_WORKSPACE', deps)('w1')
    await handler('RELOCATE_PROJECT_WORKSPACE', deps)({ id: 'w1', rootPath: '/fixture-new' })
    expect(calls).toEqual(['list', 'create:new', 'update:w1', 'reorder:w1', 'delete:w1', 'bind', 'bind', 'unbind:w1', 'relocate'])
    const failed = handler('CREATE_WORKSPACE', { ...deps, getLocalCoreClient: () => null, isLocalCoreEnabled: () => true })
    await expect(failed('new')).rejects.toThrow('本机Core尚未就绪')
    expect(await handler('LIST_WORKSPACES', { ...deps, getLocalCoreClient: () => null,
      isLocalCoreEnabled: () => false, listAgentWorkspaces: () => [workspace] })()).toEqual([workspace])
  })

  test('本机工作区异步响应在切Core或client替换后拒绝且不广播', async () => {
    const cases: Array<{ channel: string; method: string; args: unknown[]; result: unknown }> = [
      { channel: 'LIST_WORKSPACES', method: 'listWorkspaces', args: [], result: [] },
      { channel: 'CREATE_WORKSPACE', method: 'createManagedWorkspace', args: ['new'], result: { id: 'w' } },
      { channel: 'UPDATE_WORKSPACE', method: 'updateWorkspace', args: ['w', { name: 'new' }], result: { id: 'w' } },
      { channel: 'DELETE_WORKSPACE', method: 'deleteWorkspace', args: ['w'], result: undefined },
      { channel: 'REORDER_WORKSPACES', method: 'reorderWorkspaces', args: [['w']], result: [] },
      { channel: 'CREATE_PROJECT_WORKSPACE', method: 'bindProjectWorkspace', args: [{ rootPath: '/fixture' }], result: { workspace: { id: 'w' } } },
      { channel: 'OPEN_PROJECT_WORKSPACE', method: 'bindProjectWorkspace', args: [{ rootPath: '/fixture' }], result: { workspace: { id: 'w' } } },
      { channel: 'REMOVE_PROJECT_WORKSPACE', method: 'removeProjectWorkspace', args: ['w'], result: undefined },
      { channel: 'RELOCATE_PROJECT_WORKSPACE', method: 'relocateProjectWorkspace', args: [{ id: 'w', rootPath: '/fixture' }], result: { workspace: { id: 'w' } } },
    ]
    for (const entry of cases) for (const change of ['generation', 'client', 'target']) {
      let generation = 1, target = 'local', broadcasts = 0
      let active: object
      const client = { [entry.method]: async () => {
        if (change === 'generation') generation++
        if (change === 'client') active = {}
        if (change === 'target') target = 'remote'
        return entry.result
      } }
      active = client
      const invoke = handler(entry.channel, { getCurrentCoreTargetId: () => target, getLocalCoreClient: () => active,
        getCoreTargetGeneration: () => generation, getActiveCoreClient: () => null,
        broadcastAgentWorkspacesChanged: () => { broadcasts++ }, createAgentWorkspace: noDesktop, listAgentWorkspaces: noDesktop })
      await expect(invoke(...entry.args)).rejects.toThrow('Core已切换')
      expect(broadcasts).toBe(0)
    }
  })

  test('删除路由本地Core，失败不提交桌面删除队列', async () => {
    const calls: string[] = []
    const invoke = handler('DELETE_SESSION', {
      getLocalCoreClient: () => ({ deleteSession: async (id: string) => { calls.push(id) } }), requestSessionDeletion: noDesktop,
    })
    await invoke(session.id)
    expect(calls).toEqual([session.id])
    const failed = handler('DELETE_SESSION', {
      getLocalCoreClient: () => ({ deleteSession: async () => { throw new Error('Core failed') } }), requestSessionDeletion: noDesktop,
    })
    await expect(failed(session.id)).rejects.toThrow('Core failed')
  })

  test.each(['PRESET:UPDATE_SESSION_PRESET', 'PRESET:REBIND_SESSION_REFERENCE', 'UPDATE_SESSION_AGENT_RUNTIME'])('%s 只提交Core，不读写桌面会话和默认设置', async channel => {
    const reference = { presetId: 'code', presetScope: 'builtin-meta' }
    let submitted: unknown
    const invoke = handler(channel, {
      routeSessionMetaToCore: async (id: string, patch: unknown) => { submitted = { id, patch }; return session },
      getAgentSessionMeta: noDesktop, updateAgentSessionMeta: noDesktop, updateSettings: noDesktop,
      rebindAgentSessionPreset: noDesktop, publishAgentSessionProjection: noDesktop,
    })
    const preset = channel.startsWith('PRESET:')
    expect(await invoke(session.id, preset ? channel.includes('REBIND') ? reference : 'code' : 'pi', 7)).toEqual(session)
    expect(submitted).toEqual({ id: session.id, patch: preset
      ? channel.includes('REBIND') ? { presetReference: reference, expectedRevision: 7 } : { presetId: 'code', expectedRevision: 7 }
      : { agentRuntime: 'pi' } })
  })

  test('三个会话推理设置由当前Core写入，不读取桌面metadata；Core错误不回落', async () => {
    const cases = [
      ['UPDATE_SESSION_CODEX_FAST_MODE', true, { codexFastMode: true }],
      ['UPDATE_SESSION_OPENAI_THINKING', 'xhigh', { openAIThinkingLevel: 'xhigh' }],
      ['UPDATE_SESSION_AGENT_EFFORT', 'max', { agentEffort: 'max' }],
    ] as const
    for (const [channel, value, patch] of cases) {
      let submitted: unknown
      let guarded = false
      const invoke = handler(channel, {
        assertSensitiveAgentIpcSender: () => { guarded = true },
        routeSessionMetaToCore: async (id: string, body: unknown) => { submitted = { id, body }; return { ...session, ...patch } },
        getAgentSessionMeta: noDesktop, isAgentSessionActive: noDesktop, updateAgentSessionUiMeta: noDesktop,
      })
      expect(await invoke(session.id, value)).toMatchObject({ id: session.id, ...patch })
      expect(guarded).toBe(true)
      expect(submitted).toEqual({ id: session.id, body: patch })
      const failed = handler(channel, {
        routeSessionMetaToCore: async () => { throw new Error('Core unavailable') },
        getAgentSessionMeta: noDesktop, isAgentSessionActive: noDesktop, updateAgentSessionUiMeta: noDesktop,
      })
      await expect(failed(session.id, value)).rejects.toThrow('Core unavailable')
    }
  })

  test('Core推理设置只在合法值下接受更新', async () => {
    const cases = [
      ['UPDATE_SESSION_CODEX_FAST_MODE', 'true'],
      ['UPDATE_SESSION_OPENAI_THINKING', 'ultra'],
      ['UPDATE_SESSION_AGENT_EFFORT', 'xhigh'],
    ] as const
    for (const [channel, value] of cases) {
      const invoke = handler(channel, { routeSessionMetaToCore: noDesktop, getAgentSessionMeta: noDesktop, isAgentSessionActive: noDesktop, updateAgentSessionUiMeta: noDesktop })
      await expect(invoke(session.id, value)).rejects.toThrow()
    }
  })

  test('手动标题更新由Core写入并生成定稿锁定状态', async () => {
    let submitted: unknown
    let guarded = false
    const invoke = handler('UPDATE_TITLE', {
      assertSensitiveAgentIpcSender: () => { guarded = true },
      routeSessionMetaToCore: async (id: string, patch: unknown) => { expect(guarded).toBe(true); submitted = { id, patch }; return { ...session, title: 'Renamed' } },
      updateAgentSessionUiMeta: noDesktop,
    })
    expect(await invoke(session.id, 'Renamed')).toMatchObject({ id: session.id, title: 'Renamed' })
    expect(submitted).toEqual({ id: session.id, patch: { title: 'Renamed' } })
    const failed = handler('UPDATE_TITLE', { routeSessionMetaToCore: async () => { throw new Error('Core unavailable') }, updateAgentSessionUiMeta: noDesktop })
    await expect(failed(session.id, 'Renamed')).rejects.toThrow('Core unavailable')
  })

  test('Core修改失败不回落桌面；拒绝来自非当前Core的会话', async () => {
    const invoke = handler('PRESET:UPDATE_SESSION_PRESET', {
      routeSessionMetaToCore: async () => { throw new Error('Core unavailable') }, getAgentSessionMeta: noDesktop,
    })
    await expect(invoke(session.id, 'code')).rejects.toThrow('Core unavailable')
    const start = source.indexOf('async function routeSessionMetaToCore(')
    const end = source.indexOf('\nfunction assertLocalCoreTarget', start)
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
    const calls: unknown[] = []
    const client = { updateSessionMeta: async (id: string, patch: unknown) => { calls.push({ id, patch }); return { id } } }
    const route = new Function('getCurrentCoreTargetId', 'parseCoreSessionId', 'getActiveCoreClient', 'currentCoreId', 'getLocalCoreClient', `${js}; return routeSessionMetaToCore`)(
      () => 'remote', (id: string) => ({ coreId: id === 'wrong' ? 'other' : 'owner', sessionId: 'raw' }), () => client, () => 'owner', () => null,
    ) as (id: string, patch: object) => Promise<unknown>
    await expect(route('wrong', { agentRuntime: 'pi' })).rejects.toThrow('远程会话不可用')
    expect(calls).toEqual([])
    expect(await route('core:owner:raw', { presetId: 'code', expectedRevision: 4 })).toMatchObject({ id: 'core:owner:raw' })
    expect(calls).toEqual([{ id: 'raw', patch: { presetId: 'code', expectedRevision: 4 } }])
  })

  test.each([
    ['TOGGLE_PIN', { type: 'toggle_pin' }],
    ['TOGGLE_ARCHIVE', { type: 'toggle_archive' }],
    ['CLEAR_COMPLETION_STATE', { type: 'set_unread', unread: false }],
    ['SET_COMPLETION_STATE', { type: 'set_unread', unread: true }],
  ])('%s 向Core提交业务动作，不接触桌面索引', async (channel, action) => {
    let received: unknown
    const invoke = handler(String(channel), {
      routeSessionUiActionToCore: async (id: string, value: unknown) => { received = { id, action: value }; return session },
      listAgentSessions: noDesktop, updateAgentSessionUiMeta: noDesktop, setAgentSessionUnread: noDesktop,
    })
    expect(await invoke(session.id)).toEqual(session)
    expect(received).toEqual({ id: session.id, action })
  })

  test('中断说明交给Core清除，不写桌面metadata', async () => {
    let received: unknown
    const invoke = handler('UPDATE_INTERRUPTION_STATE', {
      routeSessionUiActionToCore: async (id: string, action: unknown) => { received = { id, action }; return session },
      updateAgentSessionUiMeta: noDesktop,
    })
    expect(await invoke({ sessionId: session.id, state: null })).toEqual(session)
    expect(received).toEqual({ id: session.id, action: { type: 'set_interruption', state: null } })
  })

  test('Given 已连接 Core When 新建会话 Then 默认runtime/预设由Core解析，不读取桌面配置', async () => {
    let submitted: unknown
    const client = { createSession: async (input: unknown) => { submitted = input; return session } }
    const invoke = handler('CREATE_SESSION', {
      getLocalCoreClient: () => client,
      getAgentWorkspace: noDesktop, getDefaultPresetId: noDesktop, getSettings: noDesktop,
      presetReferenceForId: noDesktop, createAgentSession: noDesktop,
    })
    expect(await invoke('Title', 'channel', 'workspace', 'model')).toEqual(session)
    expect(submitted).toEqual({ useCoreDefaults: true, title: 'Title', channelId: 'channel', workspaceId: 'workspace', modelId: 'model', presetId: undefined })
    expect(await invoke('Title', 'channel', 'workspace', 'model', 'explicit-preset')).toEqual(session)
    expect(submitted).toMatchObject({ presetId: 'explicit-preset' })
  })

  test('Given 远程 Core 新建会话 When 返回 Then 保留权威权限模式/来源/revision', async () => {
    const remote = { ...session, permissionMode: 'plan', permissionModeSource: 'preset', revision: 2 }
    const client = { createSession: async () => remote }
    const invoke = handler('CREATE_SESSION', {
      getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => client,
      currentCoreId: () => 'remote', namespaceCoreSessionId: (id: string, coreId: string) => `core:${coreId}:${id}`,
      getLocalCoreClient: noDesktop, createAgentSession: noDesktop,
    })
    expect(await invoke('Title')).toMatchObject({ id: 'core:remote:core-session', permissionMode: 'plan', permissionModeSource: 'preset', revision: 2 })
  })

  test('Given Core 创建失败 When 新建 Then 不回落桌面', async () => {
    const invoke = handler('CREATE_SESSION', {
      getLocalCoreClient: () => ({ createSession: async () => { throw new Error('Core unavailable') } }),
      getAgentWorkspace: () => undefined, getDefaultPresetId: () => 'standard',
      presetReferenceForId: () => ({ presetId: 'standard', presetScope: 'builtin-meta' }), createAgentSession: noDesktop,
    })
    await expect(invoke('Title')).rejects.toThrow('Core unavailable')
  })

  test('项目草稿由所属Core原子ensure，失败不读取桌面索引或创建普通会话', async () => {
    let submitted: unknown
    let guarded = false
    const draft = { ...session, draft: true, workspaceId: 'owner-workspace' }
    const client = { ensureProjectDraftSession: async (input: unknown) => { expect(guarded).toBe(true); submitted = input; return draft } }
    const dependencies = {
      assertSensitiveAgentIpcSender: () => { guarded = true },
      getLocalCoreClient: () => client, getCoreTargetGeneration: () => 1,
      getAgentWorkspace: noDesktop, ensureProjectDraftAgentSession: noDesktop, getSettings: noDesktop,
    }
    expect(await handler('ENSURE_PROJECT_DRAFT_SESSION', dependencies)('owner-workspace', 'channel', 'model')).toEqual(draft)
    expect(submitted).toEqual({ workspaceId: 'owner-workspace', channelId: 'channel', modelId: 'model' })
    const failed = { ensureProjectDraftSession: async () => { throw new Error('Core unavailable') } }
    await expect(handler('ENSURE_PROJECT_DRAFT_SESSION', { ...dependencies, getLocalCoreClient: () => failed })('owner-workspace')).rejects.toThrow('Core unavailable')
    const remote = { ...dependencies, getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => client, currentCoreId: () => 'owner',
      projectCoreSessionMeta: (value: typeof draft, coreId: string) => ({ ...value, id: `core:${coreId}:${value.id}` }) }
    expect(await handler('ENSURE_PROJECT_DRAFT_SESSION', remote)('owner-workspace')).toEqual({ ...draft, id: `core:owner:${draft.id}` })
    let generation = 1
    const stale = { ensureProjectDraftSession: async () => { generation++; return draft } }
    await expect(handler('ENSURE_PROJECT_DRAFT_SESSION', { ...remote, getActiveCoreClient: () => stale, getCoreTargetGeneration: () => generation })('owner-workspace')).rejects.toThrow('Core已切换')
    await expect(handler('ENSURE_PROJECT_DRAFT_SESSION', { ...dependencies, getLocalCoreClient: () => stale, getCoreTargetGeneration: () => generation })('owner-workspace')).rejects.toThrow('Core已切换')
  })

  test('远程工作区更新和删除只调用当前Core，不访问桌面工作区', async () => {
    const calls: unknown[] = []
    const client = { updateWorkspace: async (id: string, updates: unknown) => { calls.push({ op: 'update', id, updates }); return { id, name: 'remote' } }, deleteWorkspace: async (id: string) => { calls.push({ op: 'delete', id }) } }
    const deps = { getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => client, getCoreTargetGeneration: () => 1, broadcastAgentWorkspacesChanged: () => {}, updateAgentWorkspace: noDesktop, deleteAgentWorkspace: noDesktop,
      assertSensitiveAgentIpcSender: () => {} }
    expect(await handler('UPDATE_WORKSPACE', deps)('workspace', { name: 'remote', archived: true })).toEqual({ id: 'workspace', name: 'remote' })
    await handler('DELETE_WORKSPACE', deps)('workspace')
    expect(calls).toEqual([{ op: 'update', id: 'workspace', updates: { name: 'remote', archived: true } }, { op: 'delete', id: 'workspace' }])
    const failed = { ...deps, getActiveCoreClient: () => ({ updateWorkspace: async () => { throw new Error('Core unavailable') } }) }
    await expect(handler('UPDATE_WORKSPACE', failed)('workspace', { name: 'remote' })).rejects.toThrow('Core unavailable')
  })

  test('远程工作区重排/解绑只发当前Core，失败和代次变化不走桌面也不广播旧结果', async () => {
    const calls: unknown[] = []
    let generation = 1, broadcasts = 0, allowed = false
    const client = { reorderWorkspaces: async (ids: string[]) => { expect(allowed).toBe(true); calls.push(ids); return [{ id: 'remote' }] },
      removeProjectWorkspace: async (id: string) => { expect(allowed).toBe(true); calls.push(id) } }
    const deps = { getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => client, getCoreTargetGeneration: () => generation,
      assertSensitiveAgentIpcSender: () => { allowed = true }, broadcastAgentWorkspacesChanged: () => { broadcasts++ },
      reorderAgentWorkspaces: noDesktop, removeProjectWorkspace: noDesktop, pauseAutomationsForWorkspace: noDesktop, withProjectWorkspaceErrorCode: noDesktop }
    expect(await handler('REORDER_WORKSPACES', deps)(['remote'])).toEqual([{ id: 'remote' }])
    await handler('REMOVE_PROJECT_WORKSPACE', deps)('project')
    expect(calls).toEqual([['remote'], 'project'])
    expect(broadcasts).toBe(2)
    const stale = { reorderWorkspaces: async () => { generation++; return [] }, removeProjectWorkspace: async () => { generation++ } }
    await expect(handler('REORDER_WORKSPACES', { ...deps, getActiveCoreClient: () => stale })(['remote'])).rejects.toThrow('Core已切换')
    await expect(handler('REMOVE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => stale })('project')).rejects.toThrow('Core已切换')
    expect(broadcasts).toBe(2)
    const failed = { reorderWorkspaces: async () => { throw new Error('Core unavailable') }, removeProjectWorkspace: async () => { throw new Error('Core unavailable') } }
    await expect(handler('REORDER_WORKSPACES', { ...deps, getActiveCoreClient: () => failed })(['remote'])).rejects.toThrow('Core unavailable')
    await expect(handler('REMOVE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => failed })('project')).rejects.toThrow('Core unavailable')
    await expect(handler('REORDER_WORKSPACES', { ...deps, getActiveCoreClient: () => null })(['remote'])).rejects.toThrow('未连接')
    await expect(handler('REMOVE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => null })('project')).rejects.toThrow('未连接')
  })

  test('远程项目重新定位不读写桌面路径，Core失败/切换不回退且不广播旧结果', async () => {
    const input = { id: 'project', rootPath: '/remote/new' }
    let generation = 1, broadcasts = 0, guarded = false
    const result = { workspace: { id: 'project', slug: 'same' }, created: false, warnings: [] }
    const client = { relocateProjectWorkspace: async (value: unknown) => { expect(guarded).toBe(true); expect(value).toEqual(input); return result } }
    const deps = { getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => client, getCoreTargetGeneration: () => generation,
      assertSensitiveAgentIpcSender: () => { guarded = true }, broadcastAgentWorkspacesChanged: () => { broadcasts++ }, withProjectWorkspaceErrorCode: noDesktop, relocateProjectWorkspace: noDesktop }
    expect(await handler('RELOCATE_PROJECT_WORKSPACE', deps)(input)).toEqual(result)
    const failing = { relocateProjectWorkspace: async () => { throw new Error('Core unavailable') } }
    await expect(handler('RELOCATE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => failing })(input)).rejects.toThrow('Core unavailable')
    const stale = { relocateProjectWorkspace: async () => { generation++; return result } }
    await expect(handler('RELOCATE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => stale })(input)).rejects.toThrow('Core已切换')
    await expect(handler('RELOCATE_PROJECT_WORKSPACE', { ...deps, getActiveCoreClient: () => null })(input)).rejects.toThrow('未连接')
    expect(broadcasts).toBe(1)
  })

  test('远程工作区断连不回退桌面路径', async () => {
    const deps = { getCurrentCoreTargetId: () => 'remote', getActiveCoreClient: () => null, getCoreTargetGeneration: () => 1, updateAgentWorkspace: noDesktop, deleteAgentWorkspace: noDesktop,
      assertSensitiveAgentIpcSender: () => {} }
    await expect(handler('UPDATE_WORKSPACE', deps)('workspace', { name: 'remote' })).rejects.toThrow('未连接')
    await expect(handler('DELETE_WORKSPACE', deps)('workspace')).rejects.toThrow('未连接')
  })

  test('Given Core 列表含归档 When 列出 Then 过滤归档并调用既有轻量投影', async () => {
    const invoke = handler('LIST_SESSIONS', {
      getLocalCoreClient: () => ({ listSessions: async () => [session, { ...session, id: 'archived', archived: true }] }),
      listAgentSessions: noDesktop, toAgentSessionSummary: (value: typeof session) => ({ id: value.id }),
    })
    expect(await invoke(false)).toEqual([{ id: session.id }])
    expect(await invoke(true)).toEqual([{ id: session.id }, { id: 'archived' }])
  })

  test('Given Core metadata When 查询 Then 读取 Core，缺失返回 null', async () => {
    const invoke = handler('GET_SESSION_META', {
      getLocalCoreClient: () => ({ listSessions: async () => [session] }), getAgentSessionMeta: noDesktop,
    })
    expect(await invoke(session.id)).toEqual(session)
    expect(await invoke('missing')).toBeNull()
  })

  test('远程列表和metadata保留Core推理/显示状态，关联会话加命名空间且不泄漏原生资产', async () => {
    const start = source.indexOf('function projectCoreSessionMeta(')
    const end = source.indexOf('\nasync function routeSessionUiActionToCore', start)
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
    const project = new Function('buildAgentSessionUiProjection', 'projectRemoteRunEvent', 'namespaceCoreSessionId', `${js}; return projectCoreSessionMeta`)(
      buildAgentSessionUiProjection, projectRemoteRunEvent, (id: string, coreId: string) => `core:${coreId}:${id}`,
    ) as (value: object, coreId: string) => Record<string, unknown>
    const metadata = { ...session, codexFastMode: true, agentEffort: 'max', openAIThinkingLevel: 'xhigh', permissionMode: 'plan',
      completedButUnconfirmed: true, parentSessionId: 'parent', rootSessionId: 'parent', sdkSessionId: 'private', piSessionFile: 'private-file' }
    const archived = { ...metadata, id: 'archived', archived: true }
    const client = { listSessions: async () => [metadata, archived] }
    const dependencies = { getCurrentCoreTargetId: () => 'target', currentCoreId: () => 'owner', getActiveCoreClient: () => client,
      parseCoreSessionId: (id: string) => ({ coreId: id.startsWith('core:owner:') ? 'owner' : 'other', sessionId: id.split(':').at(-1) }),
      projectCoreSessionMeta: project, getAgentSessionMeta: noDesktop, getLocalCoreClient: noDesktop, listAgentSessions: noDesktop }
    const listed = await handler('LIST_SESSIONS', dependencies)(false) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: 'core:owner:core-session', codexFastMode: true, agentEffort: 'max', openAIThinkingLevel: 'xhigh', permissionMode: 'plan',
      completedButUnconfirmed: true, parentSessionId: 'core:owner:parent', rootSessionId: 'core:owner:parent' })
    expect(listed[0]?.sdkSessionId).toBeUndefined()
    expect(listed[0]?.piSessionFile).toBeUndefined()
    expect(await handler('LIST_SESSIONS', dependencies)(true)).toHaveLength(2)
    expect(await handler('GET_SESSION_META', dependencies)('core:owner:core-session')).toEqual(listed[0])
    expect(await handler('GET_SESSION_META', dependencies)('core:owner:missing')).toBeNull()
    await expect(handler('GET_SESSION_META', dependencies)('core:other:core-session')).rejects.toThrow('远程会话不可用')
    let active = client
    const switching = { listSessions: async () => { active = client; return [metadata] } }
    active = switching
    await expect(handler('LIST_SESSIONS', { ...dependencies, getActiveCoreClient: () => active })(false)).rejects.toThrow('Core已切换')
  })

  describe('Core 消息历史与运行态路由', () => {
    // 与 IPC fixture 一样执行生产代码，只替换依赖；不在测试中重写归属/代次校验。
    const routeSource = readFileSync(new URL('./core-native-routing.ts', import.meta.url), 'utf8')
    const routeCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(routeSource
      .slice(routeSource.indexOf('export function captureCoreNativeRoute('), routeSource.indexOf('export interface CoreNativeSnapshot'))
      .replace('export function', 'function'))

    function setup({ remote = false, enabled = true, getMessages = async (_id: string) => ['one', 'two', 'three'],
      getSessionDetail = async (_id: string): Promise<{ active?: boolean }> => ({ active: false }) } = {}) {
      const client = { getMessages, getSessionDetail, isConnected: true }
      const state = { remote, generation: 1, client: client as typeof client | null }
      const dependencies = {
        getCurrentCoreTargetId: () => state.remote ? 'target' : 'local',
        getCoreTargetGeneration: () => state.generation,
        getActiveCoreClient: () => state.client,
        getLocalCoreClient: () => state.client,
        isLocalCoreEnabled: () => enabled,
        currentCoreId: () => 'owner',
        parseCoreSessionId: (id: string) => {
          const match = /^core:([^:]+):(.+)$/.exec(id)
          return match ? { coreId: match[1], sessionId: match[2] } : null
        },
      }
      const captureCoreNativeRoute = new Function(...Object.keys(dependencies), `${routeCode}\nreturn captureCoreNativeRoute`)(...Object.values(dependencies))
      const history = (getAgentSessionSDKMessages: (...args: unknown[]) => unknown = noDesktop) =>
        handler('GET_SDK_MESSAGES', { captureCoreNativeRoute, getAgentSessionSDKMessages })
      const activity = (isAgentSessionActive: (id: string) => boolean = noDesktop) =>
        handler('GET_SESSION_ACTIVITY', { captureCoreNativeRoute, isAgentSessionActive })
      return { state, client, history, activity, id: remote ? `core:owner:${session.id}` : session.id }
    }

    test.each([false, true])('本机/远端（remote=%s）保持同一分页和无分页契约', async remote => {
      const reads: string[] = []
      const { history, id } = setup({ remote, getMessages: async id => { reads.push(id); return ['one', 'two', 'three'] } })
      const invoke = history()
      expect(await invoke(id, { tail: 1, before: 2 })).toEqual({ messages: ['two'], total: 3, startIndex: 1, endIndex: 2, hasMore: true })
      expect(await invoke(id)).toEqual(['one', 'two', 'three'])
      expect(reads).toEqual([session.id, session.id])
    })

    test.each([false, true])('本机/远端（remote=%s）拒绝非当前 Core 会话和未连接', async remote => {
      const { state, history, id } = setup({ remote, getMessages: noDesktop })
      const invoke = history()
      await expect(invoke(`core:other:${session.id}`, { tail: 1 })).rejects.toThrow('不属于当前')
      state.client = null
      await expect(invoke(id)).rejects.toThrow('未连接')
    })

    test.each([false, true])('丢弃迟到历史：同代次换客户端（%s）或切换代次', async replaceClient => {
      const read = Promise.withResolvers<string[]>()
      const { state, history, id } = setup({ remote: replaceClient, getMessages: () => read.promise })
      const pending = history()(id, { tail: 1 })
      if (replaceClient) state.client = { ...state.client!, getMessages: noDesktop }
      else { state.remote = true; state.generation += 1 }
      read.resolve(['old'])
      await expect(pending).rejects.toThrow('忽略旧会话响应')
    })

    test.each([false, true])('从本机/远端 Core 获取权威 true/false', async remote => {
      let active = true
      const { activity, id } = setup({ remote, getSessionDetail: async coreId => {
        expect(coreId).toBe(session.id)
        return { active }
      } })
      const invoke = activity()
      expect(await invoke(id)).toBe(true)
      active = false
      expect(await invoke(id)).toBe(false)
    })

    test.each([false, true])('本机/远端运行态不可用不会返回 false', async remote => {
      const read = Promise.withResolvers<{ active?: boolean }>()
      const { state, client, activity, id } = setup({ remote, getSessionDetail: () => read.promise })
      const invoke = activity()
      await expect(invoke(`core:other:${session.id}`)).rejects.toThrow('不属于当前')
      const pending = invoke(id)
      client.isConnected = false
      read.resolve({ active: false })
      await expect(pending).rejects.toThrow('已断开')
      await expect(invoke(id)).rejects.toThrow('未连接')
      state.client = null
      await expect(invoke(id)).rejects.toThrow('未连接')
    })

    test('运行态请求失败或缺少 active 不视为已停止', async () => {
      const offline = setup({ getSessionDetail: async () => { throw new Error('读取失败') } })
      await expect(offline.activity()(offline.id)).rejects.toThrow('读取失败')
      const incomplete = setup({ getSessionDetail: async () => ({}) })
      await expect(incomplete.activity()(incomplete.id)).rejects.toThrow('未返回有效')
    })

    test.each([false, true])('拒绝切换目标或同代次换连接后的迟到运行态', async replaceClient => {
      const read = Promise.withResolvers<{ active: boolean }>()
      const { state, client, activity, id } = setup({ remote: replaceClient, getSessionDetail: () => read.promise })
      const pending = activity()(id)
      if (replaceClient) state.client = { ...client }
      else { state.remote = true; state.generation += 1 }
      read.resolve({ active: false })
      await expect(pending).rejects.toThrow('忽略旧会话响应')
    })

    test('明确的 legacy 模式保留桌面运行态', async () => {
      const { state, activity, id } = setup({ enabled: false })
      state.client = null
      expect(await activity(sessionId => sessionId === id)(id)).toBe(true)
    })

    test('仅在 legacy 模式下原样调用桌面历史读取', async () => {
      const { state, history, id } = setup({ enabled: false })
      state.client = null
      const invoke = history((...args) => args)
      expect(await invoke(id)).toEqual([id])
      expect(await invoke(id, { tail: 1 })).toEqual([id, { tail: 1 }])
    })
  })

  test('Given Core When 更新模型 Then 写 Core；运行中仍拒绝', async () => {
    let writes = 0
    const dependencies = {
      getLocalCoreClient: () => ({ updateSessionMeta: async (id: string, patch: unknown) => { writes++; return { id, patch } } }),
      updateAgentSessionUiMeta: noDesktop,
    }
    expect(await handler('UPDATE_SESSION_MODEL', dependencies)(session.id, 'channel', 'model')).toEqual({ id: session.id, patch: { channelId: 'channel', modelId: 'model' } })
    await expect(handler('UPDATE_SESSION_MODEL', { ...dependencies, isAgentSessionActive: () => true })(session.id, 'channel', 'model')).rejects.toThrow('Agent 正在运行')
    expect(writes).toBe(1)
  })
})


describe('可信手动权限入口', () => {
  test('Given Core owns session When 用户选择权限 Then 只提交模式，由 Core 判定来源', async () => {
    let submitted: unknown
    const invoke = handler('UPDATE_SESSION_PERMISSION_MODE', {
      routeSessionMetaToCore: async (id: string, patch: unknown) => { submitted = { id, patch }; return session },
      getAgentSessionMeta: noDesktop, updateAgentSessionMeta: noDesktop,
    })
    expect(await invoke(session.id, 'bypassPermissions', 3)).toEqual(session)
    expect(submitted).toEqual({ id: session.id, patch: { permissionMode: 'bypassPermissions', expectedRevision: 3 } })
  })

  test.each([false, true])('Given legacy active=%s When 手动选择 Then 保存 user 来源并发布', async active => {
    let stored = { ...session, permissionMode: 'plan', permissionModeSource: 'preset' }
    const published: unknown[] = [], synced: string[] = []
    const invoke = handler('UPDATE_SESSION_PERMISSION_MODE', {
      routeSessionMetaToCore: async () => null, getLocalCoreClient: () => null,
      getAgentSessionMeta: () => stored,
      updateAgentSessionMeta: (_id: string, patch: object) => (stored = { ...stored, ...patch }),
      isAgentSessionActive: () => active,
      updateAgentPermissionMode: async (_id: string, mode: string) => { synced.push(mode) },
      publishAgentSessionProjection: (meta: unknown) => published.push(meta), goalSessionService: { nudge() {} },
    })
    expect(await invoke(session.id, 'bypassPermissions')).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'user' })
    expect(synced).toEqual(active ? ['bypassPermissions'] : [])
    expect(published).toEqual([stored])
  })

  test('Given 运行中 SDK 切换失败 When 选择权限 Then 模式与来源一并回滚且不 nudge', async () => {
    let stored = { ...session, permissionMode: 'plan', permissionModeSource: 'preset' }
    const published: unknown[] = []
    const invoke = handler('UPDATE_SESSION_PERMISSION_MODE', {
      routeSessionMetaToCore: async () => null, getLocalCoreClient: () => null,
      getAgentSessionMeta: () => stored,
      updateAgentSessionMeta: (_id: string, patch: object) => (stored = { ...stored, ...patch }),
      isAgentSessionActive: () => true,
      updateAgentPermissionMode: async () => { throw new Error('SDK failed') },
      publishAgentSessionProjection: (meta: unknown) => published.push(meta), goalSessionService: { nudge: noDesktop },
    })
    await expect(invoke(session.id, 'bypassPermissions')).rejects.toThrow('SDK failed')
    expect(stored).toMatchObject({ permissionMode: 'plan', permissionModeSource: 'preset' })
    expect(published).toEqual([stored])
  })

  test('Given revision 冲突 When 手动选择 Then 不写存储/SDK', async () => {
    const invoke = handler('UPDATE_SESSION_PERMISSION_MODE', {
      routeSessionMetaToCore: async () => null, getLocalCoreClient: () => null,
      getAgentSessionMeta: () => ({ ...session, revision: 4 }), updateAgentSessionMeta: noDesktop,
      updateAgentPermissionMode: noDesktop,
    })
    await expect(invoke(session.id, 'plan', 3)).rejects.toThrow('REVISION_CONFLICT')
  })

  test.each(['PRESET:UPDATE_SESSION_PRESET', 'PRESET:REBIND_SESSION_REFERENCE'])('Given legacy 正在运行 When %s Then 拒绝且不改绑', async channel => {
    const invoke = handler(channel, {
      routeSessionMetaToCore: async () => null, getAgentSessionMeta: () => session,
      isAgentSessionActive: () => true, rebindAgentSessionPreset: noDesktop,
      getAgentPreset: noDesktop, updateAgentSessionUiMeta: noDesktop,
    })
    await expect(invoke(session.id, 'code')).rejects.toThrow('正在运行')
  })
})


function remotePermissionCommand(dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')
  const start = source.indexOf("    case 'update_permission_mode':")
  const end = source.indexOf("    // Agent 预设", start)
  const ts = `async function invoke(parsed) { switch(parsed.type) { ${source.slice(start, end)} } }; return invoke;`
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(ts)
  const deps = { validateExpectedRevision: () => null, buildSessionItem: (meta: unknown) => meta, ...dependencies }
  return new Function(...Object.keys(deps), js)(...Object.values(deps)) as (input: object) => Promise<unknown>
}

test('Given Pocket 显式权限设置 When 成功 Then 同样写 user 来源；SDK 失败一并回滚', async () => {
  let stored = { ...session, permissionMode: 'plan', permissionModeSource: 'preset' }
  let shouldFail = false
  const invoke = remotePermissionCommand({
    getAgentSessionMeta: () => stored,
    updateAgentSessionMeta: (_id: string, patch: object) => (stored = { ...stored, ...patch }),
    isAgentSessionActive: () => true,
    updateAgentPermissionMode: async () => { if (shouldFail) throw new Error('SDK failed') },
    publishAgentSessionProjection() {}, agentEventBus: { emit() {} },
  })
  expect(await invoke({ type: 'update_permission_mode', sessionId: session.id, mode: 'bypassPermissions' })).toMatchObject({ ok: true, data: { permissionModeSource: 'user' } })
  shouldFail = true
  expect(await invoke({ type: 'update_permission_mode', sessionId: session.id, mode: 'plan' })).toMatchObject({ ok: false, error: 'SDK failed' })
  expect(stored).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'user' })
})

function runtimePermissionUpdate(dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL('./agent-service.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export async function updateAgentPermissionMode(')
  const end = source.indexOf('// ===== 流式追加消息', start)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end).replace('export async', 'async') + '; return updateAgentPermissionMode;')
  const deps = {
    isLocalCoreSessionActive: () => false, isLocalCoreEnabled: () => false,
    runtimeCoordinator: { isRunning: () => true }, getAgentSessionMeta: () => session,
    resolveSessionDelegationPermissionCap: () => undefined,
    sdkPermissionModeForProferMode: (mode: string) => mode,
    orchestrator: { updateSessionPermissionMode: noDesktop }, ...dependencies,
  }
  return new Function(...Object.keys(deps), js)(...Object.values(deps)) as (id: string, mode: string) => Promise<void>
}

test('Given runtime SDK 热切换 When SDK 确认/失败 Then 本轮控制器后写/不写且失败回滚 SDK', async () => {
  const calls: string[] = [], modes: string[] = []
  let shouldFail = false
  const controller = { getMode: () => 'plan', setMode: (mode: string) => modes.push(mode) }
  const update = runtimePermissionUpdate({
    getAgentRuntimePlanMode: () => controller,
    adapter: { setPermissionMode: async (_id: string, mode: string) => { calls.push(mode); if (shouldFail && mode === 'bypassPermissions') throw new Error('SDK failed') } },
  })
  await update(session.id, 'bypassPermissions')
  expect(modes).toEqual(['bypassPermissions'])
  modes.length = calls.length = 0
  shouldFail = true
  await expect(update(session.id, 'bypassPermissions')).rejects.toThrow('SDK failed')
  expect(modes).toEqual([])
  expect(calls).toEqual(['bypassPermissions', 'plan'])
})

test('Given SDK 等待中旧 run 被换 When 成功返回 Then 不污染新 run 的控制器', async () => {
  const modes: string[] = []
  let current = { getMode: () => 'plan', setMode: (mode: string) => modes.push(mode) }
  const update = runtimePermissionUpdate({
    getAgentRuntimePlanMode: () => current,
    adapter: { setPermissionMode: async () => { current = { getMode: () => 'auto', setMode: noDesktop } } },
  })
  await update(session.id, 'bypassPermissions')
  expect(modes).toEqual([])
})


test('Given 桌面 ExitPlan 用户审批 When 生效 Then 保存可信 user 来源', async () => {
  let stored = { ...session, permissionMode: 'plan', permissionModeSource: 'preset' }
  const invoke = handler('EXIT_PLAN_MODE_RESPOND', {
    getLocalCoreClient: () => null,
    exitPlanService: { respondToExitPlanMode: () => ({ sessionId: session.id, targetMode: 'bypassPermissions' }) },
    getAgentSessionMeta: () => stored,
    updateAgentSessionMeta: (_id: string, patch: object) => (stored = { ...stored, ...patch }),
    publishAgentSessionProjection() {}, emitSessionStreamEvent() {},
  })
  await invoke({ requestId: 'approval', action: 'approve_auto' })
  expect(stored).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeSource: 'user' })
})

test('Given Pocket ExitPlan 用户审批 When 生效 Then 保存可信 user 来源', async () => {
  const source = readFileSync(new URL('./remote-service.ts', import.meta.url), 'utf8')
  const start = source.indexOf("    case 'respond_exit_plan_mode':")
  const end = source.indexOf("    case 'get_sdk_messages':", start)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`async function invoke(parsed) { switch(parsed.type) { ${source.slice(start, end)} } }; return invoke;`)
  let stored = { ...session, permissionMode: 'plan', permissionModeSource: 'preset' }
  const deps = {
    exitPlanService: { respondToExitPlanMode: () => ({ sessionId: session.id, targetMode: 'auto' }) },
    updateAgentSessionUiMeta: (_id: string, patch: object) => (stored = { ...stored, ...patch }),
    agentEventBus: { emit() {} },
  }
  const invoke = new Function(...Object.keys(deps), js)(...Object.values(deps))
  await invoke({ type: 'respond_exit_plan_mode', requestId: 'approval', action: 'approve_edit' })
  expect(stored).toMatchObject({ permissionMode: 'auto', permissionModeSource: 'user' })
})

test('Given SDK 更新及回滚均失败 When 本轮仍有效 Then 停止权限未知的运行', async () => {
  const stops: string[] = []
  const controller = { getMode: () => 'plan', setMode: noDesktop }
  const update = runtimePermissionUpdate({
    getAgentRuntimePlanMode: () => controller,
    runtimeCoordinator: { isRunning: () => true, stop: async (id: string) => { stops.push(id) } },
    adapter: { setPermissionMode: async () => { throw new Error('SDK failed') } },
  })
  await expect(update(session.id, 'bypassPermissions')).rejects.toThrow('SDK failed')
  expect(stops).toEqual([session.id])
})
