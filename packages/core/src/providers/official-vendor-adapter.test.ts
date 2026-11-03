import { describe, expect, test } from 'bun:test'
import { resolveProviderNativeProtocol } from '@profer/shared'
import { getAdapter, resolveTitleBaseUrl } from './index.ts'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { streamSSE } from './sse-reader.ts'
import type { ProviderAdapter } from './types.ts'

/**
 * Chat 侧的官方厂商端点覆盖。
 *
 * custom（OpenAI 兼容格式）渠道填的是各家官方 API 地址时，Pi 运行时已按原生协议发请求，
 * 但 Chat 曾经一律按 openai-completions 打到 `/chat/completions`——Anthropic / Google
 * 没有这个端点，表现为「Agent 能用、Chat 404」。这里用假 fetch 走完整流式链路，
 * 断言真实请求地址与请求体形态，而不是只断言适配器类型。
 */

interface CapturedCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** 假 fetch：记录生产代码实际发出的 URL / 请求头 / 请求体，并回一段最小 SSE。 */
function createFakeFetch(): { calls: CapturedCall[]; fetchFn: typeof globalThis.fetch } {
  const calls: CapturedCall[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    // `[DONE]` 会被 SSE 读取器统一跳过：这里只关心请求侧事实，不需要伪造内容事件。
    return new Response('data: [DONE]\n\n', { status: 200 })
  }) as typeof globalThis.fetch
  return { calls, fetchFn }
}

/** 走真实的 buildStreamRequest → streamSSE 链路，返回 fetch 实际收到的请求。 */
async function streamChatOnce(adapter: ProviderAdapter, baseUrl: string, modelId: string): Promise<CapturedCall> {
  const request = adapter.buildStreamRequest({
    baseUrl,
    apiKey: 'fixture-key',
    modelId,
    history: [],
    userMessage: 'hi',
    readImageAttachments: () => [],
  })
  const { calls, fetchFn } = createFakeFetch()
  await streamSSE({ request, adapter, onEvent: () => {}, fetchFn })
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('getAdapter：官方厂商端点改用原生协议', () => {
  test('custom 指向 api.anthropic.com 时按 Anthropic Messages 发请求', async () => {
    const adapter = getAdapter('custom', undefined, 'https://api.anthropic.com')
    expect(adapter).toBeInstanceOf(AnthropicAdapter)

    const call = await streamChatOnce(adapter, 'https://api.anthropic.com', 'claude-sonnet-4-6')
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    // Anthropic 请求体是 messages + max_tokens，不是 OpenAI 的 chat/completions 形态
    expect(call.body.messages).toBeArray()
    expect(call.body.max_tokens).toBeNumber()
    expect(call.body.stream).toBe(true)
    expect(call.body.input).toBeUndefined()
    // 官方端点必须带 anthropic-version 与 x-api-key，否则 401/400
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.headers['x-api-key']).toBe('fixture-key')
  })

  test('custom 填了完整 /v1/messages 端点时不会重复拼接', async () => {
    const adapter = getAdapter('custom', undefined, 'https://api.anthropic.com/v1/messages')
    const call = await streamChatOnce(adapter, 'https://api.anthropic.com/v1/messages', 'claude-sonnet-4-6')
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
  })

  test('custom 指向 generativelanguage.googleapis.com 时按 Gemini 原生协议发请求', async () => {
    const adapter = getAdapter('custom', undefined, 'https://generativelanguage.googleapis.com')
    expect(adapter).toBeInstanceOf(GoogleAdapter)

    const call = await streamChatOnce(adapter, 'https://generativelanguage.googleapis.com', 'gemini-2.5-pro')
    expect(call.url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro')
    expect(call.url).toContain('streamGenerateContent')
    expect(call.url).toContain('key=fixture-key')
    // Gemini 请求体是 contents，没有 OpenAI 的 messages
    expect(call.body.contents).toBeArray()
    expect(call.body.messages).toBeUndefined()
  })

  test('custom 填了 /v1beta 版本根时不会拼出双层版本段', async () => {
    const adapter = getAdapter('custom', undefined, 'https://generativelanguage.googleapis.com/v1beta')
    const call = await streamChatOnce(adapter, 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-pro')
    expect(call.url).toContain('/v1beta/models/gemini-2.5-pro')
    expect(call.url).not.toContain('/v1beta/v1beta')
  })

  test('openai 渠道被填成官方 Anthropic 地址时与 Pi 运行时判定一致', async () => {
    // 选错供应商但地址是官方端点：Pi 已按原生协议发请求，Chat 不能继续打 /chat/completions。
    expect(getAdapter('openai', undefined, 'https://api.anthropic.com')).toBeInstanceOf(AnthropicAdapter)
  })
})

describe('getAdapter：Mistral 保持 OpenAI 兼容协议', () => {
  test('api.mistral.ai 仍走 /chat/completions，请求体是 OpenAI 形态', async () => {
    // 刻意不切原生协议：Chat 请求体只有 {model,messages,stream,tools}，Mistral 接受；
    // 切协议会引入一份没人验证过的请求体转换，收益为负。此用例锁住这个决定。
    const adapter = getAdapter('custom', undefined, 'https://api.mistral.ai/v1')
    expect(adapter).toBeInstanceOf(OpenAIAdapter)
    expect(resolveProviderNativeProtocol('custom', 'https://api.mistral.ai/v1')).toBe('mistral-conversations')

    const call = await streamChatOnce(adapter, 'https://api.mistral.ai/v1', 'mistral-large-latest')
    expect(call.url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(call.body.messages).toBeArray()
    expect(call.body.stream).toBe(true)
    expect(call.body.contents).toBeUndefined()
  })
})

describe('getAdapter：中转站行为零变化', () => {
  const relays = [
    'https://anthropic-relay.example.com',
    'https://api.anthropic.com.relay.example.com',
    'https://google-relay.example.com',
    'https://gateway.example.com',
    'https://gateway.example.com/v1',
  ]

  for (const relay of relays) {
    test(`${relay} 仍是 OpenAI 兼容适配器 + /chat/completions`, async () => {
      const adapter = getAdapter('custom', undefined, relay)
      expect(adapter).toBeInstanceOf(OpenAIAdapter)

      const call = await streamChatOnce(adapter, relay, 'relay-model')
      expect(call.url.endsWith('/chat/completions')).toBe(true)
      expect(call.url).not.toContain('/messages')
      expect(call.body.messages).toBeArray()
      expect(call.body.contents).toBeUndefined()
    })
  }
})

describe('getAdapter：既有端点形态判定仍优先', () => {
  test('完整 /responses 端点覆盖官方厂商端点', () => {
    // 端点形态优先于 host 表：即使 host 命中 Anthropic，用户填的 /responses 端点仍是事实。
    expect(resolveProviderNativeProtocol('custom', 'https://api.anthropic.com/v1/responses')).toBe('openai-responses')
    expect(getAdapter('custom', undefined, 'https://api.anthropic.com/v1/responses')).toBeInstanceOf(OpenAIResponsesAdapter)
  })

  test('无 baseUrl 的 custom 渠道保持 OpenAI 兼容', () => {
    expect(getAdapter('custom')).toBeInstanceOf(OpenAIAdapter)
  })
})

describe('标题生成旁路跟随同一份端点判定', () => {
  test('custom + 官方 Anthropic 端点：标题请求打到 /v1/messages', () => {
    const adapter = getAdapter('custom', undefined, 'https://api.anthropic.com')
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
    const request = adapter.buildTitleRequest({
      baseUrl: resolveTitleBaseUrl('custom', 'https://api.anthropic.com') ?? '',
      apiKey: 'fixture-key',
      modelId: 'claude-sonnet-4-6',
      prompt: 'fixture',
    })
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(request.body)).toMatchObject({ stream: false })
  })

  test('custom + 官方 Gemini 端点：标题请求打到 /v1beta/models', () => {
    const adapter = getAdapter('custom', undefined, 'https://generativelanguage.googleapis.com')
    expect(adapter).toBeInstanceOf(GoogleAdapter)
    const request = adapter.buildTitleRequest({
      baseUrl: resolveTitleBaseUrl('custom', 'https://generativelanguage.googleapis.com') ?? '',
      apiKey: 'fixture-key',
      modelId: 'gemini-2.5-flash',
      prompt: 'fixture',
    })
    expect(request.url).toContain('/v1beta/models/gemini-2.5-flash')
    expect(request.url).not.toContain('/chat/completions')
  })

  test('custom + Mistral：标题仍走 /chat/completions', () => {
    const adapter = getAdapter('custom', undefined, 'https://api.mistral.ai/v1')
    const request = adapter.buildTitleRequest({
      baseUrl: resolveTitleBaseUrl('custom', 'https://api.mistral.ai/v1') ?? '',
      apiKey: 'fixture-key',
      modelId: 'mistral-large-latest',
      prompt: 'fixture',
    })
    expect(request.url).toBe('https://api.mistral.ai/v1/chat/completions')
  })

  test('中转站标题地址不被改写', () => {
    expect(resolveTitleBaseUrl('custom', 'https://anthropic-relay.example.com/v1')).toBe(
      'https://anthropic-relay.example.com/v1',
    )
  })
})
