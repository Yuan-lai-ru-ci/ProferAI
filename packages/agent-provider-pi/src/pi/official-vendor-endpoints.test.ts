import { describe, expect, test } from 'bun:test'
import { stream } from '@earendil-works/pi-ai/compat'
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'
import { buildModel, normalizePiApi } from './model-registry'

/**
 * 官方厂商端点（Mistral / Anthropic / Google）在 `custom` 渠道下必须走各自原生协议：
 * 它们的官方 OpenAI 兼容层要么是方言（Mistral 严格 schema），要么根本不存在
 * （Anthropic / Google 没有 `/chat/completions`）。
 *
 * 这里用真实 pi-ai 适配器 + 假 fetch 断言最终请求地址与请求体形态，
 * 而不是只断言 `model.api`——api 到 URL/body 的映射由 pi-ai 决定，
 * 只测 api 会在依赖升级时静默失效。
 *
 * 中转站（域名任意）不在表内，必须保持 openai-completions，见 model-registry 的
 * mistral-request-compat.test.ts 与 shared 的 provider-capability.test.ts。
 */

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
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

async function registerCustomModel(baseUrl: string, modelId: string) {
  const fixture = fakeSdk()
  await buildModel(fixture.sdk, {
    sessionId: 'fixture-official-vendor',
    apiKey: 'fixture-key',
    provider: 'custom',
    baseUrl,
    model: modelId,
  })
  const registered = fixture.models.at(-1)!
  return { ...registered, provider: 'profer-custom-fixture' } as Parameters<typeof stream>[0]
}

/**
 * 抓一次请求。返回 400 让适配器走错误分支：这里只关心请求形态，
 * 响应解析由各自协议的既有测试覆盖。
 */
async function captureRequest(model: Parameters<typeof stream>[0]): Promise<CapturedRequest> {
  const requests: CapturedRequest[] = []
  const fixtureFetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('{"error":{"message":"fixture"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const events = stream(model, {
    messages: [
      { role: 'system', content: 'fixture system', timestamp: Date.now() },
      { role: 'user', content: 'hi', timestamp: Date.now() },
    ],
  } as never, { apiKey: 'fixture-key', fetch: fixtureFetch, maxTokens: 256 } as never)
  for await (const _event of events as AsyncIterable<unknown>) {
    // 忽略事件内容：只关心发出的请求。
  }
  expect(requests).toHaveLength(1)
  return requests[0]!
}

describe('官方厂商端点走原生协议', () => {
  test('Given custom 渠道指向 api.anthropic.com When 请求 Then 打 /v1/messages 且不带 OpenAI 专有字段', async () => {
    expect(normalizePiApi('custom', 'https://api.anthropic.com')).toBe('anthropic-messages')

    const model = await registerCustomModel('https://api.anthropic.com', 'claude-sonnet-4-5')
    expect(model.api).toBe('anthropic-messages')
    // Anthropic SDK 自行拼 /v1/messages，baseUrl 必须是协议根
    expect(model.baseUrl).toBe('https://api.anthropic.com')

    const { url, body } = await captureRequest(model)
    expect(url).toContain('https://api.anthropic.com/v1/messages')
    expect(body.messages).toBeDefined()
    expect(body.store).toBeUndefined()
    expect(body.stream_options).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  test('Given custom 渠道指向 generativelanguage.googleapis.com When 注册模型 Then 归一到 v1beta 协议根', async () => {
    expect(normalizePiApi('custom', 'https://generativelanguage.googleapis.com')).toBe('google-generative-ai')

    const model = await registerCustomModel('https://generativelanguage.googleapis.com', 'gemini-2.5-pro')
    expect(model.api).toBe('google-generative-ai')
    // Google 适配器把 baseUrl 当成“已含版本段”的协议根（apiVersion=""），
    // 官方端点必须补齐 /v1beta，否则请求会打到站点根拿到 HTML。
    // 该适配器不接受自定义 fetch（会直接报错），因此这里只能断言注册结果，
    // 请求地址由 pi-ai 的 @google/genai 客户端拼接。
    expect(model.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  test('Given 用户填了 Google 官方 OpenAI 兼容层 When 请求 Then 保持 openai-completions', async () => {
    expect(normalizePiApi('custom', 'https://generativelanguage.googleapis.com/v1beta/openai'))
      .toBe('openai-completions')
  })
})
