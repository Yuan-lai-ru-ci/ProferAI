import { describe, expect, test } from 'bun:test'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

const context = normalizeContext({ messages: [{ role: 'user', content: 'offline', timestamp: 0 }] })
const offlineAbort = 'PROFER_OFFLINE_QWEN_PAYLOAD'

function model(id: string, field: 'max_tokens' | 'max_completion_tokens'): Model<'openai-completions'> {
  const preview = id.includes('preview')
  return {
    id, name: id, api: 'openai-completions', provider: 'alibaba',
    baseUrl: 'https://fixture.invalid/v1', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576, maxTokens: preview ? 393216 : 262144,
    thinkingLevelMap: { off: preview ? null : 'off', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, maxTokensField: field },
  }
}

async function capture(id: string, field: 'max_tokens' | 'max_completion_tokens', reasoning?: ThinkingLevel, maxTokens?: number) {
  let payload: unknown
  const result = await streamSimple(model(id, field), context, {
    apiKey: 'offline', reasoning, maxTokens,
    onPayload(value) { payload = value; throw new Error(offlineAbort) },
  }).result()
  expect(result.errorMessage).toContain(offlineAbort)
  return payload
}

describe('Qwen4 Max 非思考输出上限', () => {
  for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
    for (const reasoning of [undefined, 'low', 'medium', 'high'] as const) {
      test(`${field} 正式版 ${reasoning ?? 'off'} 保留正确预算与思考字段`, async () => {
        const payload = await capture('qwen4-max', field, reasoning)
        expect(payload).toMatchObject({ [field]: reasoning ? 262144 : 131072, enable_thinking: !!reasoning })
        if (reasoning) expect(payload).toHaveProperty('reasoning_effort', reasoning)
        else expect(payload).not.toHaveProperty('reasoning_effort')
        expect(payload).not.toHaveProperty(field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens')
      })
    }
    test(`${field} 正式版保留显式更小值`, async () => {
      expect(await capture('qwen4-max', field, undefined, 8192)).toMatchObject({ [field]: 8192, enable_thinking: false })
    })
    test(`${field} 归一化大小写、空格与命名空间后精确匹配正式版`, async () => {
      expect(await capture(' Qwen/QWEN4-MAX ', field)).toMatchObject({ [field]: 131072 })
    })
    for (const id of ['qwen4-max-preview', 'qwen3.8-max']) {
      test(`${field} ${id} 不截断`, async () => {
        expect(await capture(id, field, 'high')).toMatchObject({ [field]: id.includes('preview') ? 393216 : 262144, enable_thinking: true })
      })
    }
    test(`${field} Qwen3.8 关闭思考也不截断`, async () => {
      expect(await capture('qwen3.8-max', field)).toMatchObject({ [field]: 262144, enable_thinking: false })
    })
  }
})
