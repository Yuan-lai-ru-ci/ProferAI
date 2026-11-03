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

  test('Given 远程 Ollama + Pi runtime When 测试连接 Then 使用 OpenAI Chat Completions', async () => {
    responder = async () => json({ choices: [{ message: { content: 'fixture' } }] })
    const result = await testChannelDirect(input('ollama', {
      baseUrl: 'https://remote.example/v1',
      modelId: 'fixture-model',
      runtime: 'pi',
    }))
    expect(result).toMatchObject({ success: true, message: '模型 fixture-model 生成测试成功' })
    expect(requests[0]!.url).toBe('https://remote.example/v1/chat/completions')
  })

  test('Given 本机 Ollama + Pi runtime When 测试连接 Then 保留 Anthropic 兼容测试路径', async () => {
    responder = async () => json({ content: [{ type: 'text', text: 'fixture' }] })
    const result = await testChannelDirect(input('ollama', {
      baseUrl: 'http://127.0.0.1:11434',
      modelId: 'fixture-model',
      runtime: 'pi',
    }))
    expect(result).toMatchObject({ success: true, message: '模型 fixture-model 生成测试成功' })
    expect(requests[0]!.url).toBe('http://127.0.0.1:11434/v1/messages')
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
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1beta/models/manual-fixture:generateContent'])
    expect(requests.every(({ init }) => init.method === 'POST' && init.signal instanceof AbortSignal)).toBe(true)
  })

  test('Given xAI 渠道选择 Chat Completions When 测试 Then 请求 /chat/completions 而非 /responses', async () => {
    responder = async () => json({ choices: [{ message: { content: 'fixture' } }] })
    expect((await testChannelDirect(input('xai', { modelId: 'grok-4.3', apiProtocol: 'chat-completions' }))).success).toBe(true)
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/chat/completions')

    requests.length = 0
    responder = async () => json({ output: [{ type: 'message', content: [{ text: 'fixture' }] }] })
    expect((await testChannelDirect(input('xai', { modelId: 'grok-4.3' }))).success).toBe(true)
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/responses')
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
    for (const item of [{ name: 'models/' }, { name: '' }, { name: ' ' }, { name: 'models/x', displayName: 5 },
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

  test('Given 第三方 Gemini 网关简化目录 When 发现 Then 接受裸模型ID与缺失能力声明', async () => {
    responder = async () => json({
      models: [
        { name: 'gemini-3.7-flash', displayName: 'gemini-3.7-flash' },
        { name: 'gemini-3.1-pro-preview', supportedGenerationMethods: null },
        { name: 'models/gemini-official', supportedGenerationMethods: ['generateContent'] },
        { name: 'text-embedding', supportedGenerationMethods: ['embedContent'] },
        { name: 'gemini-null-fields', displayName: null, supportedGenerationMethods: null },
      ],
      // 网关把“无下一页”写成 null，不能当成缺失游标的损坏分页。
      nextPageToken: null,
    })
    const result = await fetchModels(input('google', { baseUrl: 'https://fixture.invalid' }))
    expect(result.success).toBe(true)
    expect(result.models.map((model) => model.id)).toEqual([
      'gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-official', 'gemini-null-fields',
    ])
    expect(new URL(requests[0]!.url).pathname).toBe('/v1beta/models')
    // null 游标不得触发第二页请求。
    expect(requests).toHaveLength(1)
  })

  test('Given 目录校验失败 When 发现/测试 Then 透出具体原因且不泄Key', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    responder = async () => json({ models: [{ name: 'models/x', supportedGenerationMethods: 'generateContent' }] })
    expect((await fetchModels(input('google'))).message).toContain('Google 模型生成能力结构无效')
    expect((await testChannelDirect(input('google'))).message).toContain('Google 模型生成能力结构无效')
    responder = async () => { throw new Error('upstream key=fixture-key rejected') }
    const message = (await fetchModels(input('google'))).message
    expect(message).toContain('key=***')
    expect(message).not.toContain('fixture-key')
  })

  test('Given Google 端点误填 /v1 When 目录/生成 Then 统一剥到原生 /v1beta', async () => {
    responder = async ({ url }) => new URL(url).pathname.endsWith('/models')
      ? json({ models: [{ name: 'gemini-fixture', supportedGenerationMethods: null }] })
      : json({ candidates: [{ content: { parts: [{ text: 'fixture' }] } }] })
    const fixture = input('google', { baseUrl: 'https://fixture.invalid/v1/?route=fixture#anchor' })
    expect((await fetchModels(fixture)).success).toBe(true)
    expect(new URL(requests[0]!.url).pathname).toBe('/v1beta/models')
    expect(new URL(requests[0]!.url).searchParams.get('route')).toBe('fixture')
    expect((await testChannelDirect({ ...fixture, modelId: 'gemini-fixture' })).success).toBe(true)
    expect(new URL(requests[1]!.url).pathname).toBe('/v1beta/models/gemini-fixture:generateContent')
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

describe('Pi 本机 Ollama 目录拉取', () => {
  test('Given 本机 Ollama + Pi runtime When 拉取目录 Then 保留原生 /api/tags', async () => {
    responder = async () => json(valid('ollama'))
    const result = await fetchModels(input('ollama', { baseUrl: 'http://127.0.0.1:11434', runtime: 'pi' }))
    expect(result.success).toBe(true)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/tags')
  })
})

describe('Claude-only 渠道目录拉取', () => {
  test('Given Claude-only 且配置了 Claude 端点 When 拉取目录 Then 按 SDK 语义请求 /v1/models', async () => {
    responder = async () => json(valid('anthropic'))
    const result = await fetchModels(input('openai', { runtime: 'claude', agentBaseUrl: 'https://fixture.invalid/anthropic' }))
    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toMatch(/^https:\/\/fixture\.invalid\/anthropic\/v1\/models/)
  })

  test('Given Claude-only 且带 /anthropic 路径 When 测试生成 Then 请求 /anthropic/v1/messages', async () => {
    responder = async () => json({ content: [{ type: 'text', text: 'ok' }] })
    const result = await testChannelDirect(input('openai', {
      runtime: 'claude',
      agentBaseUrl: 'https://fixture.invalid/anthropic',
      modelId: 'fixture-model',
    }))
    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://fixture.invalid/anthropic/v1/messages')
  })

  test('Given Claude 端点无法推导 When 拉取目录 Then 明确失败且不发送请求', async () => {
    const result = await fetchModels(input('xai', { runtime: 'claude' }))
    expect(result).toMatchObject({ success: false, models: [] })
    expect(requests).toHaveLength(0)
  })
})

describe('P0-3：Chat / Claude / Pi 的 Anthropic 端点统一', () => {
  const messagePayload = { content: [{ type: 'text', text: 'ok' }] }

  test('Given provider=anthropic 且 base 为 /anthropic When Chat 测试/发现 Then 与 Agent 一致请求 /anthropic/v1', async () => {
    responder = async ({ url }) => json(url.includes('/messages') ? messagePayload : valid('anthropic'))
    const fixture = input('anthropic', { baseUrl: 'https://fixture.invalid/anthropic' })
    expect((await testChannelDirect(fixture)).success).toBe(true)
    expect((await fetchModels(fixture)).success).toBe(true)
    expect(requests.map(({ url }) => url)).toEqual([
      'https://fixture.invalid/anthropic/v1/models',
      'https://fixture.invalid/anthropic/v1/models',
    ])
    expect((await testChannelDirect({ ...fixture, modelId: 'fixture-model' })).success).toBe(true)
    expect(requests.at(-1)!.url).toBe('https://fixture.invalid/anthropic/v1/messages')
  })

  test('Given anthropic-compatible 且 base 为 /anthropic When Chat 测试 Then 不再直接请求协议根', async () => {
    responder = async () => json(messagePayload)
    const result = await testChannelDirect(input('anthropic-compatible', {
      baseUrl: 'https://fixture.invalid/anthropic',
      modelId: 'fixture-model',
    }))
    expect(result.success).toBe(true)
    expect(requests[0]!.url).toBe('https://fixture.invalid/anthropic/v1/messages')
  })

  test('Given Pi + Anthropic 协议 When 测试/发现 Then 使用 Agent 端点并拼 /v1', async () => {
    responder = async ({ url }) => json(url.includes('/messages') ? messagePayload : valid('anthropic'))
    const fixture = input('anthropic', {
      baseUrl: 'https://fixture.invalid/native',
      agentBaseUrl: 'https://fixture.invalid/anthropic',
      runtime: 'pi',
    })
    expect((await testChannelDirect({ ...fixture, modelId: 'fixture-model' })).success).toBe(true)
    expect(requests.at(-1)!.url).toBe('https://fixture.invalid/anthropic/v1/messages')
    expect((await fetchModels(fixture)).success).toBe(true)
    expect(requests.at(-1)!.url).toBe('https://fixture.invalid/anthropic/v1/models')
  })

  test('Given deepseek / minimax 的 /anthropic 根路径 When Chat 测试 Then 保持 /anthropic/v1/messages', async () => {
    responder = async () => json(messagePayload)
    for (const provider of ['deepseek', 'minimax'] as const) {
      requests.length = 0
      const result = await testChannelDirect(input(provider, {
        baseUrl: 'https://fixture.invalid/anthropic',
        modelId: 'fixture-model',
      }))
      expect(result.success).toBe(true)
      expect(requests[0]!.url).toBe('https://fixture.invalid/anthropic/v1/messages')
    }
  })

  test('Given Pi + 非 Anthropic 协议 When 测试 Then 仍走原生 OpenAI 端点', async () => {
    responder = async () => json({ choices: [{ message: { content: 'fixture' } }] })
    const result = await testChannelDirect(input('deepseek', {
      baseUrl: 'https://fixture.invalid/v1',
      runtime: 'pi',
      modelId: 'fixture-model',
    }))
    expect(result.success).toBe(true)
    expect(requests[0]!.url).toBe('https://fixture.invalid/v1/chat/completions')
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

describe('F21：OpenAI 兼容渠道（Mistral 类上游）端点推导与 404 定位', () => {
  test('Given custom + 版本根地址 When Pi 测试连接 Then 请求 /v1/chat/completions', async () => {
    for (const baseUrl of ['https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/', 'https://api.mistral.ai']) {
      responder = async () => json({ choices: [{ message: { content: 'ok' } }] })
      const result = await testChannelDirect(input('custom', { baseUrl, runtime: 'pi', modelId: 'mistral-large-latest' }))
      expect(result.success).toBe(true)
      expect(requests.at(-1)!.url).toBe('https://api.mistral.ai/v1/chat/completions')
    }
  })

  test('Given custom + 版本根地址 When 未选模型 Then 目录请求打 /v1/models', async () => {
    responder = async () => json({ data: [{ id: 'mistral-large-latest', object: 'model' }] })
    const result = await testChannelDirect(input('custom', { baseUrl: 'https://api.mistral.ai/v1', runtime: 'pi' }))
    expect(result.success).toBe(true)
    expect(requests.at(-1)!.url).toBe('https://api.mistral.ai/v1/models')
  })

  test('Given 上游路由未匹配 When 测试连接失败 Then 回显实际端点并给出路径提示', async () => {
    responder = async () => json({ message: 'no Route matched with those values', request_id: 'fixture' }, 404)
    const result = await testChannelDirect(input('custom', {
      baseUrl: 'https://api.mistral.ai/chat/completions?route=fixture-secret#anchor',
      modelId: 'mistral-large-latest',
    }))
    expect(result.success).toBe(false)
    expect(result.message).toContain('no Route matched')
    expect(result.message).toContain('上游没有匹配该路径的路由')
    // 只回显端点本身，query/hash 可能带路由凭据，不能进 UI
    expect(result.message).toContain('当前测试端点为 https://api.mistral.ai/chat/completions')
    expect(result.message).not.toContain('fixture-secret')
    expect(result.message).not.toContain('#anchor')
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
