import { describe, expect, test } from 'bun:test'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/google-generative-ai'

function model(id: string): Model<'google-generative-ai'> {
  return {
    id, name: id, api: 'google-generative-ai', provider: 'google',
    baseUrl: 'https://fixture.invalid/v1beta', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 1000,
    thinkingLevelMap: {
      off: null, minimal: null, low: 'low', medium: 'medium', high: 'high',
      xhigh: id.includes('hydrogen') ? 'xhigh' : null, max: null,
    },
  }
}
const context = normalizeContext({ messages: [{ role: 'user', content: 'offline', timestamp: 0 }] })
const offlineAbort = 'PROFER_OFFLINE_PAYLOAD_CAPTURE'

describe('Pi Google Gemini 4 离线请求协议', () => {
  for (const id of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen']) {
    for (const reasoning of ['low', 'medium', 'high', 'xhigh'] as ThinkingLevel[]) {
      test(`${id} ${reasoning} 通过真实 streamSimple 生成离散档位`, async () => {
        let payload: unknown
        const result = await streamSimple(model(id), context, {
          apiKey: 'offline', reasoning,
          onPayload(value) { payload = value; throw new Error(offlineAbort) },
        }).result()
        expect(result.errorMessage).toContain(offlineAbort)
        const expected = reasoning === 'xhigh' && !id.includes('hydrogen') ? 'HIGH' : reasoning.toUpperCase()
        expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingLevel: expected } } })
        expect(JSON.stringify(payload)).not.toContain('thinkingBudget')
      })
    }
  }

  test('Gemini 2.5 保留 budget 请求', async () => {
    const legacy = model('gemini-2.5-pro')
    let payload: unknown
    await streamSimple(legacy, context, { apiKey: 'offline', reasoning: 'high',
      onPayload(value) { payload = value; throw new Error(offlineAbort) },
    }).result()
    expect(payload).toMatchObject({ config: { thinkingConfig: { includeThoughts: true, thinkingBudget: 32768 } } })
    expect(JSON.stringify(payload)).not.toContain('thinkingLevel')
  })

  test('genai SDK 实际序列化保留 XHIGH，离线 fetch 不接触网络', async () => {
    const originalFetch = globalThis.fetch
    let body: unknown
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    try {
      const result = await streamSimple(model('gemini-4-hydrogen'), context, { apiKey: 'offline', reasoning: 'xhigh' }).result()
      expect(result.stopReason).toBe('stop')
      expect(body).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: 'XHIGH', includeThoughts: true } } })
      expect(JSON.stringify(body)).not.toContain('thinkingBudget')
    } finally { globalThis.fetch = originalFetch }
  })
})
