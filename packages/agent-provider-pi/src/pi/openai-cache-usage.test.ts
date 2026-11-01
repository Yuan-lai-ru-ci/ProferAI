import { describe, expect, test } from 'bun:test'
import type { Model, Usage } from '@earendil-works/pi-ai'
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { SDKAssistantMessage, SDKResultMessage } from '@profer/shared'
import { convertPiMessage, convertResultMessage } from './message-adapter'

const context = normalizeContext({
  systemPrompt: '固定系统指令',
  messages: [{ role: 'user', content: '检查用量', timestamp: 1 }],
})

function model<A extends 'openai-completions' | 'openai-responses'>(api: A): Model<A> {
  return {
    id: 'gpt-cache-fixture', name: '缓存测试', provider: 'openai', api,
    baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'],
    contextWindow: 200_000, maxTokens: 8_000,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
  }
}

/** 使用真实 SDK 的请求构造与 SSE 解析，仅替换 fetch；不会访问网络或使用凭据。 */
function sseFetch(events: unknown[]) {
  const requests: Array<Record<string, unknown>> = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetchFn, requests }
}

function responsesEvents(input: number, cacheRead?: number): unknown[] {
  return [
    { type: 'response.output_item.done', output_index: 0, item: {
      type: 'message', id: 'msg-fixture', role: 'assistant',
      content: [{ type: 'output_text', text: '完成', annotations: [] }],
    } },
    { type: 'response.completed', response: { id: 'resp-fixture', status: 'completed', usage: {
      input_tokens: input, output_tokens: 20, total_tokens: input + 20,
      ...(cacheRead !== undefined ? { input_tokens_details: { cached_tokens: cacheRead } } : {}),
    } } },
  ]
}

function readShare(usage: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number {
  return usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite)
}

describe('真实 Pi/OpenAI usage → Profer 字段契约', () => {
  test('Given Chat Completions 回报总输入10000和缓存9000 When 转换 Then 缓存占比90%且不重复相加', async () => {
    const fixture = sseFetch([
      { id: 'completion-fixture', choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10_000, completion_tokens: 20, total_tokens: 10_020, prompt_tokens_details: { cached_tokens: 9_000 } } },
    ])
    const message = await streamCompletions(model('openai-completions'), context, {
      apiKey: 'fixture-key', sessionId: 'stable-cache-session', fetch: fixture.fetchFn,
    }).result()
    expect(message.stopReason).toBe('stop')
    expect(message.usage).toMatchObject({ input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 20 })
    expect(readShare(message.usage)).toBe(0.9)
    expect(fixture.requests[0]?.prompt_cache_key).toBe('stable-cache-session')
    expect(fixture.requests[0]?.stream_options).toEqual({ include_usage: true })

    const converted = convertPiMessage(message, 'session', 'gpt-cache-fixture') as SDKAssistantMessage
    expect(converted.message.usage).toEqual({ input_tokens: 1_000, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 20 })
  })

  test('Given Responses 回报缓存9000 When 生成 assistant/result Then 只计算一次并保留稳定缓存键', async () => {
    const fixture = sseFetch(responsesEvents(10_000, 9_000))
    const message = await streamResponses(model('openai-responses'), context, {
      apiKey: 'fixture-key', sessionId: 'stable-cache-session', fetch: fixture.fetchFn,
    }).result()
    expect(message.stopReason).toBe('stop')
    expect(message.usage).toMatchObject({ input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 20 })
    expect(readShare(message.usage)).toBe(0.9)
    expect(fixture.requests[0]?.prompt_cache_key).toBe('stable-cache-session')
    const converted = convertResultMessage([message], 'session') as SDKResultMessage
    expect(converted.usage).toEqual({ input_tokens: 1_000, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 20 })
  })

  test('Given 多次不同长度请求 When 汇总 Then 按token加权且缓存不被计入输出', async () => {
    const messages = []
    for (const [input, cached] of [[1_000, 0], [10_000, 9_000]]) {
      const fixture = sseFetch(responsesEvents(input!, cached))
      messages.push(await streamResponses(model('openai-responses'), context, { apiKey: 'fixture-key', fetch: fixture.fetchFn }).result())
    }
    const result = convertResultMessage(messages, 'session') as SDKResultMessage
    expect(result.usage).toEqual({ input_tokens: 2_000, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 40 })
    expect(result.usage!.cache_read_input_tokens! / (result.usage!.input_tokens + result.usage!.cache_read_input_tokens!)).toBeCloseTo(9_000 / 11_000)
  })

  test('Given 上游不回报缓存字段 When 解析 Then 不虚构缓存读取量', async () => {
    const fixture = sseFetch(responsesEvents(10_000))
    const message = await streamResponses(model('openai-responses'), context, { apiKey: 'fixture-key', fetch: fixture.fetchFn }).result()
    expect(message.usage).toMatchObject({ input: 10_000, cacheRead: 0 })
  })
})
