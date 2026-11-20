import { describe, expect, test } from 'bun:test'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'

const context = normalizeContext({ messages: [{ role: 'user', content: 'offline', timestamp: 0 }] })
const offlineAbort = 'PROFER_OFFLINE_QWEN_ANTHROPIC'
function model(id: string): Model<'anthropic-messages'> {
  const preview = id.includes('preview')
  return {
    id, name: id, api: 'anthropic-messages', provider: 'qwen-anthropic',
    baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576, maxTokens: preview ? 393216 : 262144,
    thinkingLevelMap: { off: preview ? null : 'off', minimal: null, low: 'low', medium: preview ? 'medium' : 'high', high: 'xhigh', xhigh: null, max: null },
    compat: { forceAdaptiveThinking: true },
  }
}
async function capture(id: string, reasoning?: ThinkingLevel, maxTokens?: number) {
  let payload: unknown
  const result = await streamSimple(model(id), context, {
    apiKey: 'offline', reasoning, maxTokens,
    onPayload(value) { payload = value; throw new Error(offlineAbort) },
  }).result()
  expect(result.errorMessage).toContain(offlineAbort)
  return payload
}

describe('Qwen4 Anthropic effort 协议', () => {
  for (const id of ['qwen4-max', 'qwen4-max-preview']) {
    for (const reasoning of ['low', 'medium', 'high'] as const) {
      test(`${id} ${reasoning} 使用 enabled 与 output_config.effort`, async () => {
        const payload = await capture(id, reasoning)
        const effort = reasoning === 'high' ? 'xhigh' : reasoning === 'medium' && id === 'qwen4-max' ? 'high' : reasoning
        expect(payload).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort }, max_tokens: id.includes('preview') ? 393216 : 262144 })
        expect(payload).toHaveProperty('thinking', { type: 'enabled' })
      })
    }
  }
  test('正式版 off disabled 且预算限制到 131072', async () => {
    const payload = await capture('qwen4-max')
    expect(payload).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 131072 })
    expect(payload).not.toHaveProperty('output_config')
  })
  test('正式版 off 保留更小显式预算', async () => {
    expect(await capture('qwen4-max', undefined, 4096)).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 4096 })
  })
  test('preview 不支持 off 时不生成 disabled，也不截断预算', async () => {
    const payload = await capture('qwen4-max-preview')
    expect(payload).not.toHaveProperty('thinking')
    expect(payload).toHaveProperty('max_tokens', 393216)
  })
  test('命名空间与大小写归一化后仍匹配正式版', async () => {
    expect(await capture(' Qwen/QWEN4-MAX ', 'low')).toHaveProperty('thinking', { type: 'enabled' })
  })
  test('Claude legacy adaptive 格式保持不变', async () => {
    const payload = await capture('claude-opus-4-7', 'low')
    expect(payload).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' }, max_tokens: 262144 })
  })
})
