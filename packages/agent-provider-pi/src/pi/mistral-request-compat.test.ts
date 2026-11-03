import { describe, expect, test } from 'bun:test'
import { stream, streamSimple } from '@earendil-works/pi-ai/compat'
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'
import { buildModel, normalizePiApi } from './model-registry'

/**
 * 官方 Mistral 的 OpenAI 兼容层有两个硬差异：
 * 1) 请求体做 extra_forbidden 校验（store / stream_options / max_completion_tokens → 422）；
 * 2) 流式 delta.content 可能是内容块数组（text / thinking），按字符串拼接会得到 `[object Object]`。
 *
 * 因此官方端点必须走 Pi 自带的 mistral-conversations 适配器。这里用真实 pi-ai 适配器 +
 * 假 fetch 断言最终请求地址、请求体与解析结果，而不是只断言 api 字段——api 到请求/解析的
 * 映射由 pi-ai 决定，只测 api 会在依赖升级时静默失效。
 */

interface CapturedRequest {
  url: string
  body: Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> }
}

function fakeSdk() {
  const models: Array<Record<string, unknown>> = []
  const sdk = {
    ModelRuntime: {
      create: async (_options: CreateModelRuntimeOptions) => ({
        setRuntimeApiKey: async () => {},
        registerProvider: (_id: string, config: { models: Array<Record<string, unknown>> }) => models.push(...config.models),
        getModel: () => models.at(-1) ?? { id: 'fixture' },
        getModels: () => models,
      }),
    },
  } as unknown as Parameters<typeof buildModel>[0]
  return { sdk, models }
}

async function registerCustomModel(baseUrl: string, modelId = 'mistral-large-latest') {
  const fixture = fakeSdk()
  await buildModel(fixture.sdk, {
    sessionId: 'fixture-mistral',
    apiKey: 'fixture-key',
    provider: 'custom',
    baseUrl,
    model: modelId,
  })
  const registered = fixture.models.at(-1)!
  return { ...registered, provider: 'profer-custom-fixture' } as Parameters<typeof stream>[0]
}

/** Mistral 真实形态：content 是内容块数组，thinking 与 text 混在同一条流里。 */
const mistralChunkedSse = [
  { choices: [{ index: 0, delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: '先想一想' }] }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: [{ type: 'text', text: '文件不多，' }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: [{ type: 'text', text: '共 12 项。' }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] },
]

async function runStream(
  model: Parameters<typeof stream>[0],
  sse: unknown[],
  streamFn: typeof stream = stream,
  extraOptions: Record<string, unknown> = {},
): Promise<{ request: CapturedRequest; message: { content: Array<Record<string, unknown>> } }> {
  const requests: CapturedRequest[] = []
  const fixtureFetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    const payload = sse.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const events = streamFn(model, {
    messages: [
      { role: 'system', content: 'fixture system', timestamp: Date.now() },
      { role: 'user', content: 'hi', timestamp: Date.now() },
    ],
  } as never, { apiKey: 'fixture-key', fetch: fixtureFetch, maxTokens: 256, ...extraOptions } as never)
  let message: { content: Array<Record<string, unknown>> } | undefined
  for await (const event of events as AsyncIterable<{
    type: string
    message?: { content: Array<Record<string, unknown>> }
    error?: { errorMessage?: string }
  }>) {
    if (event.type === 'error') throw new Error(event.error?.errorMessage ?? 'fixture stream failed')
    if (event.type === 'done' && event.message) message = event.message
  }
  expect(requests).toHaveLength(1)
  return { request: requests[0]!, message: message! }
}

describe('官方 Mistral 端点使用原生 mistral-conversations 协议', () => {
  test('Given custom 渠道指向 api.mistral.ai When 发起请求 Then 地址不带重复 /v1 且请求体是 Mistral 字段集', async () => {
    const model = await registerCustomModel('https://api.mistral.ai/v1')
    expect(model.api).toBe('mistral-conversations')
    expect(model.baseUrl).toBe('https://api.mistral.ai')

    const { request } = await runStream(model, mistralChunkedSse)
    expect(request.url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(request.body.stream).toBe(true)
    expect(request.body.max_tokens).toBe(256)
    // Mistral 的 schema 里没有这些 OpenAI 专有字段，发出去就是 422
    expect(request.body.store).toBeUndefined()
    expect(request.body.stream_options).toBeUndefined()
    expect(request.body.max_completion_tokens).toBeUndefined()
    expect(request.body.messages[0]?.role).toBe('system')
  })

  test('Given Mistral 流式返回内容块数组 When 解析 Then 正文与思考分开且不出现 [object Object]', async () => {
    const model = await registerCustomModel('https://api.mistral.ai/v1')
    const { message } = await runStream(model, mistralChunkedSse)
    expect(JSON.stringify(message)).not.toContain('[object Object]')
    const text = message.content.filter((block) => block.type === 'text').map((block) => String(block.text)).join('')
    const thinking = message.content.filter((block) => block.type === 'thinking').map((block) => String(block.thinking)).join('')
    expect(text).toBe('文件不多，共 12 项。')
    expect(thinking).toBe('先想一想')
  })

  test('Given Mistral 流式返回工具调用 When 解析 Then 工具调用块名与参数可用', async () => {
    const model = await registerCustomModel('https://api.mistral.ai/v1')
    const { message } = await runStream(model, [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'abc123456', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }] },
    ])
    const toolCall = message.content.find((block) => block.type === 'toolCall')
    expect(toolCall).toBeDefined()
    expect(toolCall?.name).toBe('read_file')
    expect(toolCall?.arguments).toEqual({ path: 'a.txt' })
    expect(toolCall?.id).toBe('abc123456')
  })

  test('Given 渠道启用了非 Mistral 模型 id 且会话带思考档位 When 请求 Then 不发 prompt_mode / reasoning_effort', async () => {
    // 同一个 Mistral 渠道里可能启用 deepseek / glm 等模型 id，它们从共享 catalog 拿到的
    // reasoning 标记在 Mistral 网关上无效，发 prompt_mode 会直接 400（code 3051）。
    const model = await registerCustomModel('https://api.mistral.ai/v1', 'deepseek-v4-1-flash-1017')
    expect(model.reasoning).toBe(false)
    const { request } = await runStream(model, mistralChunkedSse, streamSimple as typeof stream, { reasoning: 'medium' })
    expect(request.body.prompt_mode).toBeUndefined()
    expect(request.body.reasoning_effort).toBeUndefined()
  })

  test('Given 自建 OpenAI 兼容网关 When 发起请求 Then 仍走 openai-completions', async () => {
    expect(normalizePiApi('custom', 'https://gateway.invalid/v1')).toBe('openai-completions')

    const model = await registerCustomModel('https://gateway.invalid/v1')
    expect(model.api).toBe('openai-completions')
    // 非官方端点不做路径归一：/v1 原样保留，仍由 openai-completions 拼 /chat/completions
    expect(model.baseUrl).toBe('https://gateway.invalid/v1')
    const { request } = await runStream(model, mistralChunkedSse)
    expect(request.body.stream_options).toEqual({ include_usage: true })
    expect(request.body.max_completion_tokens).toBe(256)
  })

  test('Given 中转站域名里带 mistral 字样 When 发起请求 Then 仍走 openai-completions 且路径不被改写', async () => {
    // 域名表只能做「精确命中官方 host」的加法，不能把含关键词的中转域名一并吞掉：
    // 中转站往往只实现 OpenAI 兼容层，误切到原生协议会直接断掉连通性。
    for (const relay of [
      'https://mistral-relay.example.com/v1',
      'https://api.mistral.ai.proxy.example.com/v1',
      'https://mistral.example.com/v1',
    ]) {
      expect(normalizePiApi('custom', relay)).toBe('openai-completions')
      const model = await registerCustomModel(relay)
      expect(model.api).toBe('openai-completions')
      expect(model.baseUrl).toBe(relay)
      const { request } = await runStream(model, mistralChunkedSse)
      expect(request.url).toBe(`${relay}/chat/completions`)
      expect(request.body.stream_options).toEqual({ include_usage: true })
    }
  })
})
