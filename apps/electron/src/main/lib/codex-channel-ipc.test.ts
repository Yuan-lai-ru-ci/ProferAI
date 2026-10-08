import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CHANNEL_IPC_CHANNELS } from '@profer/shared'

// 沿用 Goal IPC 测试模式，执行当前注册片段和 preload 方法，所有 transport/service 由 fixture 截断。
const source = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8')
const start = source.indexOf('  ipcMain.handle(\n    CHANNEL_IPC_CHANNELS.CODEX_LOGIN,')
const end = source.indexOf('  // ===== 对话管理相关 =====', start)
if (start < 0 || end < start) throw new Error('Codex IPC 注册边界不存在')
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
const register = new Function('deps', `const { ipcMain, CHANNEL_IPC_CHANNELS, loginCodexChannel, cancelCodexOAuthLogin, listCodexModels, agentCatalogInvalidationPublisher } = deps; ${js}`)
const preload = readFileSync(new URL('../../preload/index.ts', import.meta.url), 'utf8')
const preloadStart = preload.lastIndexOf('  loginCodexOAuth: (input:')
const preloadEnd = preload.indexOf('  // 对话管理', preloadStart)
if (preloadStart < 0 || preloadEnd < preloadStart) throw new Error('Codex preload 边界不存在')
const methods = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = {${preload.slice(preloadStart, preloadEnd)}};`)

describe('Codex IPC/preload 接线（fixture transport）', () => {
  test('登录创建、取消、目录都经共享通道；只在登录成功后发目录失效通知', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const inputs: unknown[] = []
    const invalidations: string[] = []
    let cancelled = 0
    const channel = { id: 'fixture-codex', apiKey: 'fixture-encrypted' }
    register({
      ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
      CHANNEL_IPC_CHANNELS,
      loginCodexChannel: async (input: unknown) => { inputs.push(input); if (input === 'fixture-denied') throw new Error('fixture-denied'); return channel },
      cancelCodexOAuthLogin: () => { cancelled += 1 },
      listCodexModels: async () => [{ id: 'gpt-6-astra', name: 'Fixture Astra' }],
      agentCatalogInvalidationPublisher: { invalidate: (name: string) => invalidations.push(name) },
    })
    const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args)
    const bridge = new Function('ipcRenderer', 'CHANNEL_IPC_CHANNELS', `${methods}; return methods`)(
      { invoke }, CHANNEL_IPC_CHANNELS,
    ) as { loginCodexOAuth: (input: unknown) => Promise<unknown>; cancelCodexOAuthLogin: () => Promise<void>; listCodexModels: () => Promise<unknown> }
    const input = { name: 'Fixture', baseUrl: '', models: [{ id: 'gpt-6-astra', enabled: true }] }
    expect(await bridge.loginCodexOAuth(input)).toEqual(channel)
    expect(await bridge.loginCodexOAuth('fixture-codex')).toEqual(channel)
    await expect(bridge.loginCodexOAuth('fixture-denied')).rejects.toThrow('fixture-denied')
    await bridge.cancelCodexOAuthLogin()
    expect(await bridge.listCodexModels()).toEqual([{ id: 'gpt-6-astra', name: 'Fixture Astra', enabled: true, source: 'fetched' }])
    expect(inputs).toEqual([input, 'fixture-codex', 'fixture-denied'])
    expect(invalidations).toEqual(['channels', 'channels'])
    expect(cancelled).toBe(1)
  })
})
