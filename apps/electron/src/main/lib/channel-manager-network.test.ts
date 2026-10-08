import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { FetchModelsInput, ProviderType } from '@profer/shared'

interface FixtureRequest { url: string; init: RequestInit }
const requests: FixtureRequest[] = []
let proxy: string | undefined
let proxyReadFails = false
const proxyArgs: (string | undefined)[] = []
let responder: (request: FixtureRequest) => Promise<Response>
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => {
  if (proxyReadFails) throw new Error('fixture proxy read failed')
  return proxy
} }))
mock.module('./proxy-fetch', () => ({ getFetchFn: (url?: string) => {
  proxyArgs.push(url)
  return async (input: string | URL, init: RequestInit) => {
    const request = { url: String(input), init }
    requests.push(request)
    return responder(request)
  }
} }))
mock.module('./codex-oauth-service', () => ({
  loginCodexOAuth: async () => { throw new Error('禁止真实 OAuth') },
  cancelCodexOAuthLogin: () => {},
  refreshCodexOAuth: async () => { throw new Error('禁止真实 OAuth') },
}))
mock.module('./xai-oauth-service', () => ({ refreshXaiOAuth: async () => { throw new Error('禁止真实 OAuth') } }))
const { fetchModels, testChannelDirect } = await import('./channel-manager')

const input = (provider: ProviderType, overrides: Partial<FetchModelsInput> = {}): FetchModelsInput => ({
  provider, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', ...overrides,
})
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
const valid = (provider: ProviderType): unknown => provider === 'google'
  ? { models: [{ name: 'models/fixture', displayName: 'Fixture', supportedGenerationMethods: ['generateContent'] }] }
  : provider === 'ollama' ? { models: [{ name: 'fixture:latest' }] }
  : { object: 'list', data: [{ id: 'fixture-model', object: 'model', display_name: 'Fixture' }] }

beforeEach(() => {
  requests.length = 0
  proxyArgs.length = 0
  proxy = undefined
  proxyReadFails = false
  responder = async () => json(valid('openai'))
})
afterEach(() => mock.restore())

describe('F14：请求超时与测试能力边界', () => {
  test('Given 各协议目录 When 测试/发现 Then 每条请求复用 15s signal 且代理参数未丢失', async () => {
    const timeouts: number[] = []
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { timeouts.push(ms); return originalTimeout(ms) })
    proxy = 'http://fixture-proxy.invalid:7890'
    for (const provider of ['anthropic', 'openai', 'google', 'ollama'] as const) {
      responder = async () => json(valid(provider))
      expect((await fetchModels(input(provider))).success).toBe(true)
      expect(await testChannelDirect(input(provider))).toMatchObject({ success: true, message: '模型目录可达（未验证模型生成）' })
    }
    expect(timeouts).toEqual(Array(8).fill(15_000))
    expect(requests.every(({ init }) => init.signal instanceof AbortSignal)).toBe(true)
    expect(proxyArgs.every((url) => url === proxy)).toBe(true)
    expect(requests.every(({ init }) => init.method === 'GET')).toBe(true)
  })

  test('Given 挂起且遵循 signal 的 fetch When 超时 Then 测试/发现明确失败并能重试', async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeouts: number[] = []
    spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { timeouts.push(ms); return originalTimeout(5) })
    spyOn(console, 'error').mockImplementation(() => {})
    responder = ({ init }) => new Promise((_resolve, reject) => {
      const signal = init.signal!
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    for (const provider of ['anthropic', 'openai', 'google', 'ollama'] as const) {
      expect((await fetchModels(input(provider))).success).toBe(false)
      expect((await testChannelDirect(input(provider))).success).toBe(false)
    }
    expect(timeouts).toEqual(Array(8).fill(15_000))
    responder = async () => json(valid('openai'))
    expect((await fetchModels(input('openai'))).success).toBe(true)
  })

  test('Given 用户手工模型 When Anthropic 测试 Then 仅发送指定模型、不要求目录或硬编码模型', async () => {
    responder = async () => json({ type: 'message', content: [{ type: 'text', text: 'fixture' }] })
    const result = await testChannelDirect(input('anthropic-compatible', {
      modelId: 'manual-fixture', baseUrl: 'https://fixture.invalid/tenant/v2/messages/?route=fixture#anchor',
    }))
    expect(result).toMatchObject({ success: true, message: '模型 manual-fixture 生成测试成功' })
    expect(requests[0]!.url).toBe('https://fixture.invalid/tenant/v2/messages?route=fixture#anchor')
    expect(JSON.parse(String(requests[0]!.init.body)).model).toBe('manual-fixture')
    expect(requests[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('Given OpenAI/Responses/Google 模型 When 测试 Then POST 原生生成端点且带超时', async () => {
    for (const provider of ['openai', 'openai-responses', 'google'] as const) {
      responder = async () => json(provider === 'google' ? { candidates: [{ content: { parts: [{ text: 'fixture' }] } }] } : provider === 'openai' ? { choices: [{ message: { content: 'fixture' } }] } : { output: [{ type: 'message', content: [{ text: 'fixture' }] }] })
      expect((await testChannelDirect(input(provider, { modelId: 'manual-fixture' }))).success).toBe(true)
    }
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/v1beta/models/manual-fixture:generateContent'])
    expect(requests.every(({ init }) => init.method === 'POST' && init.signal instanceof AbortSignal)).toBe(true)
  })

  test('Given Pi/Claude 双端点 When 指定 runtime Then 分别检查对应协议且明确标注 Claude', async () => {
    responder = async ({ url }) => json(url.includes('/messages') ? { content: [{ type: 'text', text: 'fixture' }] } : { choices: [{ message: { content: 'fixture' } }] })
    const fixture = input('custom', { modelId: 'manual-fixture',
      baseUrl: 'https://fixture.invalid/native/v1/chat/completions?route=pi#native',
      agentBaseUrl: 'https://fixture.invalid/agent/v1/messages?route=claude#agent',
    })
    expect(await testChannelDirect({ ...fixture, runtime: 'pi' })).toMatchObject({ success: false })
    expect(await testChannelDirect({ ...fixture, runtime: 'claude' })).toMatchObject({ success: false })
    expect((await testChannelDirect({ ...fixture, runtime: 'pi' })).message).toContain('query/hash')
    const supported = { ...fixture, baseUrl: 'https://fixture.invalid/native/v1/chat/completions', agentBaseUrl: 'https://fixture.invalid/agent/v1/messages' }
    expect((await testChannelDirect({ ...supported, runtime: 'pi' })).success).toBe(true)
    expect(await testChannelDirect({ ...supported, runtime: 'claude' })).toMatchObject({ success: true, message: 'Claude 端点：模型 manual-fixture 生成测试成功' })
    expect(requests.map(({ url }) => url)).toEqual([supported.baseUrl, supported.agentBaseUrl!])
    responder = async () => json({ error: { message: 'fixture denied' } })
    expect((await testChannelDirect({ ...fixture, runtime: 'claude' })).success).toBe(false)
  })

  test('Given 无效 modelId/代理读取失败 When 请求 Then 不发送网络并返回失败', async () => {
    expect((await testChannelDirect(input('openai', { modelId: ' ' }))).success).toBe(false)
    proxyReadFails = true
    spyOn(console, 'error').mockImplementation(() => {})
    expect((await fetchModels(input('openai'))).success).toBe(false)
    expect((await testChannelDirect(input('openai'))).success).toBe(false)
    expect(requests).toHaveLength(0)
  })
})

describe('F15：严格模型目录与完整分页', () => {
  test('Given HTTP200 错误包或非法模型 When 发现 Then 失败且不返回部分/空权威列表', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    for (const provider of ['anthropic', 'openai', 'google', 'ollama'] as const) {
      for (const payload of [null, [], {}, { error: { message: 'fixture' } }, { data: null }, { models: null },
        { ...valid(provider) as object, error: {} }, { ...valid(provider) as object, code: 401 }]) {
        responder = async () => json(payload)
        expect(await fetchModels(input(provider))).toMatchObject({ success: false, models: [] })
      }
    }
    for (const payload of [{ data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 5 }] },
      { data: [{ id: ' leading' }] }, { object: 'error', data: [] }, { data: [{ id: 'ok', object: 'error' }] },
      { data: [{ id: 'ok', name: 5 }] }, { data: [{ id: 'ok' }, { id: '' }] }]) {
      responder = async () => json(payload)
      expect((await fetchModels(input('openai'))).success).toBe(false)
    }
    for (const payload of [{ data: [{ id: 'ok', display_name: '' }] }, { data: [{ id: 'ok', type: 'error' }] }]) {
      responder = async () => json(payload)
      expect((await fetchModels(input('anthropic'))).success).toBe(false)
    }
    for (const payload of [{ models: [null] }, { models: [{ name: '' }] }, { models: [{ name: 5 }] }]) {
      responder = async () => json(payload)
      expect((await fetchModels(input('ollama'))).success).toBe(false)
    }
    for (const item of [{ name: 'models/' }, { name: 'fixture' }, { name: 'models/x', displayName: 5 },
      { name: 'models/x', supportedGenerationMethods: 'generateContent' }]) {
      responder = async () => json({ models: [item] })
      expect((await fetchModels(input('google'))).success).toBe(false)
    }
  })

  test('Given 合法空目录/重复ID When 发现 Then 空列表成功且结果去重、有 source', async () => {
    for (const provider of ['anthropic', 'openai', 'google', 'ollama'] as const) {
      responder = async () => json(provider === 'google' || provider === 'ollama' ? { models: [] } : { data: [] })
      expect(await fetchModels(input(provider))).toMatchObject({ success: true, models: [] })
    }
    responder = async () => json({ object: 'list', data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })
    expect((await fetchModels(input('openai'))).models).toEqual([
      { id: 'a', name: 'a', enabled: true, source: 'fetched' }, { id: 'b', name: 'b', enabled: true, source: 'fetched' },
    ])
  })

  test('Given Anthropic has_more When 翻页 Then after_id 保留路由并共享 signal、最终去重', async () => {
    responder = async ({ url }) => json(new URL(url).searchParams.has('after_id')
      ? { data: [{ id: 'a' }, { id: 'b', display_name: 'B' }], has_more: false }
      : { data: [{ id: 'a' }], has_more: true, last_id: 'a' })
    const result = await fetchModels(input('anthropic', { baseUrl: 'https://fixture.invalid/v1/messages/?route=fixture#anchor' }))
    expect(result.success).toBe(true)
    expect(result.models.map((model) => model.id)).toEqual(['a', 'b'])
    expect(requests[0]!.url).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
    expect(new URL(requests[1]!.url).searchParams.get('after_id')).toBe('a')
    expect(requests[1]!.init.signal).toBe(requests[0]!.init.signal)
  })

  test('Given Google nextPageToken When 翻页 Then 聚合生成模型、保留路由并编码 key', async () => {
    responder = async ({ url }) => json(new URL(url).searchParams.has('pageToken')
      ? { models: [{ name: 'models/b', supportedGenerationMethods: ['generateContent'] }] }
      : { models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'fixture token' })
    const result = await fetchModels(input('google', { baseUrl: 'https://fixture.invalid/v1beta/?route=fixture#anchor', apiKey: 'fixture&key' }))
    expect(result.models.map((model) => model.id)).toEqual(['b'])
    expect(new URL(requests[0]!.url).pathname).toBe('/v1beta/models')
    expect(new URL(requests[1]!.url).searchParams.get('pageToken')).toBe('fixture token')
    expect(new URL(requests[1]!.url).searchParams.get('key')).toBe('fixture&key')
    expect(new URL(requests[1]!.url).searchParams.get('route')).toBe('fixture')
    expect(requests[1]!.init.signal).toBe(requests[0]!.init.signal)
  })

  test('Given 缺失/循环游标、第二页错误、未知 OpenAI 分页 When 发现 Then 整体失败', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    for (const payload of [{ data: [{ id: 'a' }], has_more: true }, { data: [], has_more: true, last_id: 'a' },
      { data: [{ id: 'a' }], has_more: 'true' }, { data: [{ id: 'a' }], has_more: true, last_id: 'a' }]) {
      responder = async () => json(payload)
      expect(await fetchModels(input('anthropic'))).toMatchObject({ success: false, models: [] })
    }
    responder = async ({ url }) => new URL(url).searchParams.has('after_id') ? json({ error: {} }, 503)
      : json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })
    expect(await fetchModels(input('anthropic'))).toMatchObject({ success: false, models: [] })
    responder = async () => json({ models: [], nextPageToken: 'repeat' })
    expect(await fetchModels(input('google'))).toMatchObject({ success: false, models: [] })
    responder = async () => json({ data: [{ id: 'a' }], has_more: true })
    expect(await fetchModels(input('openai'))).toMatchObject({ success: false, models: [] })
  })
})

describe('F20：测试/发现 URL 一致', () => {
  test('Given OpenAI 完整端点/base query/hash When 目录测试及发现 Then 相同 /models URL', async () => {
    for (const path of ['/v1/chat/completions/', '/v1/responses/', '/v1/']) {
      const fixture = input('openai', { baseUrl: `https://fixture.invalid${path}?route=fixture#anchor` })
      expect((await testChannelDirect(fixture)).success).toBe(true)
      expect((await fetchModels(fixture)).success).toBe(true)
      expect(requests.at(-2)!.url).toBe('https://fixture.invalid/v1/models?route=fixture#anchor')
      expect(requests.at(-1)!.url).toBe(requests.at(-2)!.url)
    }
  })
})

test('F14：Given 生成挂起或错误/空响应 When 测试 Then 不报告生成成功', async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(5))
  responder = ({ init }) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
  expect((await testChannelDirect(input('anthropic', { modelId: 'manual-fixture' }))).success).toBe(false)
  for (const payload of [{}, { content: [] }, { error: {}, content: [{ type: 'text', text: 'fixture' }] }]) {
    responder = async () => json(payload)
    expect((await testChannelDirect(input('anthropic', { modelId: 'manual-fixture' }))).success).toBe(false)
  }
})

test('F15：Given 第二页挂起 When 整次发现超时 Then 不返回第一页且只创建一次 signal', async () => {
  spyOn(console, 'error').mockImplementation(() => {})
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(5))
  responder = ({ url, init }) => new URL(url).searchParams.has('after_id')
    ? new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    : Promise.resolve(json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
  expect(await fetchModels(input('anthropic'))).toMatchObject({ success: false, models: [] })
  expect(timeout).toHaveBeenCalledTimes(1)
})

test('F14：主动取消中断所有协议的目录/生成请求，保留超时且不记录凭据错误', async () => {
  const timeout = spyOn(AbortSignal, 'timeout')
  const log = spyOn(console, 'error').mockImplementation(() => {})
  for (const provider of ['anthropic', 'openai', 'openai-responses', 'google', 'ollama'] as const) {
    for (const kind of ['discover', 'test-directory', 'test-generation'] as const) {
      const controller = new AbortController()
      const count = requests.length
      responder = ({ init }) => new Promise((_resolve, reject) => {
        expect(init.signal).toBeInstanceOf(AbortSignal)
        init.signal!.addEventListener('abort', () => reject(new Error('secret fixture&key')), { once: true })
        controller.abort()
      })
      const fixture = input(provider, { apiKey: 'secret fixture&key', ...(kind === 'test-generation' ? { modelId: 'fixture-model' } : {}) })
      const result = kind === 'discover' ? await fetchModels(fixture, controller.signal) : await testChannelDirect(fixture, controller.signal)
      expect(result).toMatchObject({ success: false, cancelled: true, message: '请求已取消' })
      if ('models' in result) expect(result.models).toEqual([])
      expect(requests).toHaveLength(count + 1)
      expect(requests.at(-1)!.init.signal!.aborted).toBe(true)
    }
  }
  expect(timeout.mock.calls.map((call) => call[0])).toEqual(Array(15).fill(15_000))
  expect(log).not.toHaveBeenCalled()
})

test('F14：请求启动前已取消不读代理/网络，分页取消不返回首页，非取消错误不泄漏 secret', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(await fetchModels(input('openai'), controller.signal)).toMatchObject({ success: false, cancelled: true, models: [] })
  expect(await testChannelDirect(input('openai'), controller.signal)).toMatchObject({ success: false, cancelled: true })
  expect(requests).toHaveLength(0)
  const paging = new AbortController()
  responder = ({ url, init }) => new URL(url).searchParams.has('after_id')
    ? new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      paging.abort()
    }) : Promise.resolve(json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
  expect(await fetchModels(input('anthropic'), paging.signal)).toMatchObject({ success: false, cancelled: true, models: [] })
  expect(requests[0]!.init.signal).toBe(requests[1]!.init.signal)
  const log = spyOn(console, 'error').mockImplementation(() => {})
  responder = async () => { throw new Error('fixture-key https://fixture.invalid/?secret=fixture-key') }
  expect((await fetchModels(input('openai'))).message).not.toContain('fixture-key')
  expect((await testChannelDirect(input('openai'))).message).not.toContain('fixture-key')
  expect(log).not.toHaveBeenCalled()
})
