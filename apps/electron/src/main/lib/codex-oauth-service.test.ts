import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { shell } from 'electron'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

type Interaction = Parameters<ModelRuntime['login']>[2]
const fixture = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, accountId: 'fixture-account' }
let login: (interaction: Interaction) => Promise<unknown>
let options: unknown
let loginCalls = 0
const urls: string[] = []
// preload 已替换 Electron；直接替换该 fixture 对象方法，不加载真实 Electron。
const originalOpenExternal = shell.openExternal
shell.openExternal = async (url: string) => { urls.push(url) }
afterAll(() => { shell.openExternal = originalOpenExternal })
mock.module('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: async (input: unknown) => {
    options = input
    return { login: async (provider: string, mode: string, interaction: Interaction) => {
      expect(provider).toBe('openai-codex')
      expect(mode).toBe('oauth')
      loginCalls += 1
      return login(interaction)
    } }
  } },
}))
const { cancelCodexOAuthLogin, loginCodexOAuth } = await import('./codex-oauth-service')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { resolve, promise }
}
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
beforeEach(() => { loginCalls = 0; urls.length = 0; login = async () => fixture })

describe('Codex OAuth 服务（完整 mock SDK 与浏览器）', () => {
  test('复用 ModelRuntime 浏览器 OAuth，隔离全局 auth 目录并规范化凭据', async () => {
    const notified: string[] = []
    login = async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://fixture.invalid/oauth' })
      return { ...fixture, irrelevant: 'fixture-unused' }
    }
    const result = await loginCodexOAuth({ onAuthUrl: (url) => notified.push(url) })
    expect(result).toEqual({ access: fixture.access, refresh: fixture.refresh, expires: fixture.expires, accountId: fixture.accountId })
    expect(options).toMatchObject({ modelsPath: null, allowModelNetwork: false })
    expect(notified).toEqual(['https://fixture.invalid/oauth'])
    expect(urls).toEqual(notified)
    expect(loginCalls).toBe(1)
  })

  test('并发登录拒绝重复；取消后迟到的成功结果也被丢弃，之后可重试', async () => {
    const pending = deferred<unknown>()
    let signal: AbortSignal | undefined
    login = async (interaction) => { signal = interaction.signal; return pending.promise }
    const first = loginCodexOAuth()
    await tick()
    await expect(loginCodexOAuth()).rejects.toThrow('正在进行')
    cancelCodexOAuthLogin()
    expect(signal?.aborted).toBe(true)
    pending.resolve(fixture)
    await expect(first).rejects.toThrow('已取消')
    login = async () => fixture
    expect((await loginCodexOAuth()).refresh).toBe(fixture.refresh)
    expect(loginCalls).toBe(2)
  })

  test('SDK 尚未启动时立即取消，不启动 OAuth 且不打开 URL', async () => {
    const first = loginCodexOAuth()
    cancelCodexOAuthLogin()
    await expect(first).rejects.toThrow('已取消')
    expect(loginCalls).toBe(0)
    expect(urls).toEqual([])
  })

  test('SDK 登录失败释放锁，允许重试', async () => {
    login = async () => { throw new Error('fixture-sdk-failure') }
    await expect(loginCodexOAuth()).rejects.toThrow('fixture-sdk-failure')
    login = async () => fixture
    expect((await loginCodexOAuth()).access).toBe(fixture.access)
  })

  test('空 token、非有限或已过期凭据不视为登录成功', async () => {
    for (const invalid of [null, { ...fixture, access: '' }, { ...fixture, refresh: '' }, { ...fixture, expires: NaN }, { ...fixture, expires: Date.now() - 1 }]) {
      login = async () => invalid
      await expect(loginCodexOAuth()).rejects.toThrow('凭据')
    }
  })
})
