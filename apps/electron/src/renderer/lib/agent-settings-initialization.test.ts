import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentWorkspace, Channel } from '@profer/shared'
import type { AppSettings } from '../../types/settings'
import {
  agentChannelIdAtom, agentModelIdAtom, agentChannelIdsAtom, agentRuntimeAtom,
  agentSettingsReadyAtom, agentEffortAtom, agentSessionsAtom,
} from '../atoms/agent-atoms'
import { channelsAtom, channelsLoadedAtom } from '../atoms/chat-atoms'
import { authStatusAtom } from '../atoms/identity-atoms'
import { initializeAgentSettings } from './agent-settings-initialization'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fixture: Channel = { id: 'fixture', name: 'Fixture', provider: 'openai', apiKey: 'encrypted',
  baseUrl: 'https://fixture.invalid', enabled: true, agentRuntimes: ['pi'],
  models: [{ id: 'model', name: 'Model', enabled: true }], createdAt: 1, updatedAt: 1 }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
function setup() {
  const store = createStore()
  cleanups.push(store.sub(authStatusAtom, () => {}))
  store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
  const requests: ReturnType<typeof deferred<AppSettings>>[] = []
  const failures: unknown[] = []
  const cleanup = initializeAgentSettings(store, {
    getSettings: () => { const request = deferred<AppSettings>(); requests.push(request); return request.promise },
    listWorkspaces: async (): Promise<AgentWorkspace[]> => [], onFailure: (error) => failures.push(error),
  })
  cleanups.push(cleanup)
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
  const resolve = (index: number, patch: Partial<AppSettings> = {}) => requests[index]!.resolve({ themeMode: 'system', agentRuntime: 'pi', agentChannelId: 'fixture', agentModelId: 'model', ...patch })
  const catalog = (channels: Channel[]) => { store.set(channelsAtom, channels); store.set(channelsLoadedAtom, true) }
  return { store, requests, failures, cleanup, resolve, flush, catalog }
}

describe('启动默认模型水合（真实 Jotai store，本地 fixture）', () => {
  test('Given 设置先返回 When 目录稍后到达 Then 按最新目录/runtime解析，Pi不污染Claude白名单', async () => {
    const scope = setup()
    scope.resolve(0)
    await scope.flush()
    expect(scope.store.get(agentSettingsReadyAtom)).toBe(false)
    scope.catalog([fixture])
    expect(scope.store.get(agentSettingsReadyAtom)).toBe(true)
    expect(scope.store.get(agentChannelIdAtom)).toBe('fixture')
    expect(scope.store.get(agentModelIdAtom)).toBe('model')
    expect(scope.store.get(agentChannelIdsAtom)).toEqual([])
  })
  test('Given 目录先更新 When 迟到设置指向删除模型 Then 使用最新目录，历史会话metadata引用不变', async () => {
    const scope = setup()
    const sessions = scope.store.get(agentSessionsAtom)
    const newer = { ...fixture, models: [{ id: 'new-model', name: 'New', enabled: true }] }
    scope.catalog([newer])
    const catalog = scope.store.get(channelsAtom)
    scope.resolve(0)
    await scope.flush()
    expect(scope.store.get(channelsAtom)).toBe(catalog)
    expect(scope.store.get(agentModelIdAtom)).toBe('new-model')
    expect(scope.store.get(agentSessionsAtom)).toBe(sessions)
    // 目录刷新只校验状态，绝不重发 getSettings/LIST 造成请求 loop。
    for (let i = 0; i < 5; i += 1) scope.catalog([{ ...newer }])
    expect(scope.requests).toHaveLength(1)
  })
  test('Given Claude 默认错误指向Pi-only When 初始化 Then 不认为其有效，无兼容模型时清空内存默认', async () => {
    const scope = setup()
    scope.catalog([fixture])
    scope.resolve(0, { agentRuntime: 'claude', agentChannelIds: ['fixture'] })
    await scope.flush()
    expect(scope.store.get(agentChannelIdAtom)).toBeNull()
    expect(scope.store.get(agentModelIdAtom)).toBeNull()
    scope.catalog([{ ...fixture, provider: 'anthropic', agentRuntimes: ['claude'], models: [{ id: 'claude-model', name: 'Claude', enabled: true }] }])
    expect(scope.store.get(agentModelIdAtom)).toBe('claude-model')
  })
  test('Given 已水合默认 When 目录禁用/删除模型 Then 默认只选择enabled模型或清空，不写历史', async () => {
    const scope = setup()
    scope.catalog([fixture]); scope.resolve(0); await scope.flush()
    scope.catalog([{ ...fixture, models: [{ ...fixture.models[0]!, enabled: false }, { id: 'second', name: 'Second', enabled: true }] }])
    expect(scope.store.get(agentModelIdAtom)).toBe('second')
    scope.catalog([])
    expect(scope.store.get(agentChannelIdAtom)).toBeNull()
    expect(scope.store.get(agentModelIdAtom)).toBeNull()
  })
  test('Given 启动请求未返回 When 用户已选择新默认和effort Then 旧设置不能覆盖', async () => {
    const scope = setup()
    scope.catalog([fixture])
    scope.store.set(agentRuntimeAtom, 'pi')
    scope.store.set(agentChannelIdAtom, 'fixture')
    scope.store.set(agentModelIdAtom, 'model')
    scope.store.set(agentEffortAtom, 'low')
    scope.resolve(0, { agentRuntime: 'claude', agentChannelId: 'old', agentModelId: 'old', agentEffort: 'max' })
    await scope.flush()
    expect(scope.store.get(agentRuntimeAtom)).toBe('pi')
    expect(scope.store.get(agentModelIdAtom)).toBe('model')
    expect(scope.store.get(agentEffortAtom)).toBe('low')
  })
  test('Given Pi默认 When 内核改为Claude Then 默认按新内核解析且不修改会话', async () => {
    const scope = setup()
    const claude = { ...fixture, id: 'claude', provider: 'anthropic' as const, agentRuntimes: ['claude' as const] }
    scope.catalog([fixture, claude]); scope.resolve(0); await scope.flush()
    const sessions = scope.store.get(agentSessionsAtom)
    scope.store.set(agentRuntimeAtom, 'claude')
    expect(scope.store.get(agentChannelIdAtom)).toBe('claude')
    expect(scope.store.get(agentSessionsAtom)).toBe(sessions)
    expect(scope.requests).toHaveLength(1)
  })
  test('Given A启动请求 When A→B→A Then 只有最后代际设置水合', async () => {
    const scope = setup()
    scope.store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'b' })
    scope.store.set(authStatusAtom, { isLoggedIn: true, teamAccountId: 'a' })
    scope.catalog([fixture])
    scope.resolve(2)
    await scope.flush()
    scope.resolve(1, { agentRuntime: 'claude' }); scope.resolve(0, { agentRuntime: 'claude' })
    await scope.flush()
    expect(scope.store.get(agentRuntimeAtom)).toBe('pi')
    expect(scope.store.get(agentModelIdAtom)).toBe('model')
  })
  test('Given StrictMode卸载 When 旧回执/失败返回 Then 不写状态、不报告过期错误', async () => {
    const scope = setup()
    scope.cleanup()
    scope.resolve(0)
    await scope.flush()
    expect(scope.store.get(agentSettingsReadyAtom)).toBe(false)
    expect(scope.store.get(agentModelIdAtom)).toBeNull()
    expect(scope.failures).toEqual([])
  })
  test('Given 读取失败 When 回执当前 Then 标记就绪并报告失败，不捏造默认值', async () => {
    const scope = setup()
    scope.requests[0]!.reject(new Error('fixture-settings-failure'))
    await scope.flush()
    expect(scope.store.get(agentSettingsReadyAtom)).toBe(true)
    expect(scope.store.get(agentModelIdAtom)).toBeNull()
    expect(scope.failures).toHaveLength(1)
  })
})
