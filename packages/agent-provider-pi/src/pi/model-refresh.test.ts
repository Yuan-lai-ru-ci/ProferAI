import { describe, expect, test } from 'bun:test'
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'
import { inferContextWindow, supportsVerified1MContext } from '@profer/shared'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions'
import { streamSimple as streamGoogle } from '@earendil-works/pi-ai/api/google-generative-ai'
import { buildModel, buildXaiOAuthModel, getCodexCatalogModels, getXaiCatalogModels, resolvePiReasoningCapability, resolveKnownPiModelMetadata } from './model-registry'

function fakeSdk() {
  const models: Array<Record<string, unknown>> = []
  const sdk = { ModelRuntime: { create: async (_options: CreateModelRuntimeOptions) => ({
    setRuntimeApiKey: async () => {},
    registerProvider: (_id: string, config: { models: Array<Record<string, unknown>> }) => models.push(...config.models),
    getModel: () => models.at(-1),
  }) } } as unknown as Parameters<typeof buildModel>[0]
  return { sdk, models }
}

async function buildFixture(sdk: Parameters<typeof buildModel>[0], input: Parameters<typeof buildModel>[1], host?: Parameters<typeof buildModel>[2]) {
  return buildModel(sdk, { baseUrl: 'https://fixture.invalid/v1', ...input }, host)
}

const geminiPriceMultiplier = Date.now() >= Date.parse('2026-12-01T00:00:00Z') ? 2 : 1
const MODELS = [
  ['anthropic', 'claude-fable-5-2', 1_000_000, 128_000, 8, 40, 0.2, 10],
  ['anthropic', 'claude-opus-5-5', 1_000_000, 128_000, 4, 20, 0.2, 5],
  ['anthropic', 'claude-sonnet-5-5', 1_000_000, 128_000, 2, 10, 0.1, 2.5],
  ['anthropic', 'claude-haiku-5-5', 1_000_000, 128_000, 0.1, 0.5, 0.01, 0.125],
  ['google', 'gemini-4-carbon', 1_048_576, 65_536, 2 * geminiPriceMultiplier, 10 * geminiPriceMultiplier, 0.1 * geminiPriceMultiplier, 0],
  ['google', 'gemini-4-argon', 1_048_576, 65_536, 2 * geminiPriceMultiplier, 10 * geminiPriceMultiplier, 0.1 * geminiPriceMultiplier, 0],
  ['google', 'gemini-4-hydrogen', 1_048_576, 65_536, 1.5, 7.5, 0.075, 0],
  ['zhipu', 'glm-5.3-flash', 1_000_000, 128_000, 0.15, 0.5, 0.03, 0],
  ['zhipu', 'glm-5.3-flashx', 1_000_000, 128_000, 0.37, 1.25, 0.075, 0],
  ['xiaomi', 'mimo-v2.6-pro', 1_000_000, 128_000, 0.435, 0.87, 0.0036, 0],
  ['xiaomi', 'mimo-v2.6-flash', 1_000_000, 128_000, 0.14, 0.28, 0.0028, 0],
  ['kimi-api', 'kimi-k3.1-pro-highspeed', 1_048_576, 131_072, 4, 20, 0.2, 4],
] as const

describe('2026-11 新模型规格补齐', () => {
  for (const [provider, id, contextWindow, maxTokens, input, output, cacheRead, cacheWrite] of MODELS) {
    test(`Given ${id} 未进上游目录 When 注册 Then 带齐官方基础规格`, async () => {
      const fixture = fakeSdk()
      await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider, model: id })
      expect(fixture.models[0]).toMatchObject({
        id, reasoning: true, input: ['text', 'image'], contextWindow, maxTokens,
        cost: { input, output, cacheRead, cacheWrite },
      })
    })
  }

  test('Given GPT6.2 When 官方代管或Codex注册 Then 保留1.05M/128K与新价格，中转不擅自升窗', async () => {
    for (const [id, cost] of [
      ['gpt-6.2-astra', { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }],
      ['gpt-6.2-sol', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
    ] as const) {
      const official = fakeSdk()
      await buildFixture(official.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'openai', model: id, channelId: 'managed' }, { isOfficialManagedChannel: () => true })
      expect(official.models[0]).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], cost })
      const relay = fakeSdk()
      await buildFixture(relay.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'custom', baseUrl: 'https://gateway.invalid/v1', model: `openai/${id}` })
      expect(relay.models[0]).toMatchObject({ contextWindow: 200_000, maxTokens: 128_000, cost })
      const codex = (await getCodexCatalogModels()).find((model) => model.id === id)
      expect(codex).toMatchObject({ api: 'openai-codex-responses', contextWindow: 1_050_000, maxTokens: 128_000, cost })
    }
  })

  test('Given Gemini4 When 界面读取推理能力 Then 与SDK真实支持的档位相同', async () => {
    expect((await resolvePiReasoningCapability('google', 'gemini-4-carbon'))?.levels).toEqual(['low', 'medium', 'high'])
    expect((await resolvePiReasoningCapability('google', 'gemini-4-hydrogen'))?.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  test('Given Fable5.2/Opus5.5 When 读取档位 Then 不再出现off/minimal且xhigh不伪装为max', async () => {
    for (const modelId of ['claude-fable-5-2', 'claude-opus-5-5']) {
      const capability = await resolvePiReasoningCapability('anthropic', modelId)
      expect(capability?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      expect(capability?.effortMap?.xhigh).toBe('xhigh')
    }
  })

  test('Given MiMo2.6 When 注册 Then 保留多轮reasoning_content和thinking开关协议', async () => {
    const fixture = fakeSdk()
    await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'xiaomi', model: 'mimo-v2.6-pro' })
    expect(fixture.models[0]?.compat).toMatchObject({ thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true })
  })

  test('Given Qwen4正式版与Preview When 注册 Then 不混淆输出预算且不虚构定价', async () => {
    for (const [model, maxTokens] of [['qwen4-max', 262_144], ['qwen4-max-preview', 393_216]] as const) {
      const fixture = fakeSdk()
      await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'qwen', model })
      expect(fixture.models[0]).toMatchObject({ contextWindow: 1_000_000, maxTokens, input: ['text', 'image'] })
    }
  })

  test('Given 用户关闭1M When 新模型注册 Then 偏好仍优先', async () => {
    const fixture = fakeSdk()
    await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'anthropic', model: 'claude-fable-5-2', context1m: false })
    expect(fixture.models[0]?.contextWindow).toBe(200_000)
  })
  test('Given Grok4.7 真实xAI路径 When 注册 Then 不绕过500K与官方基础价格', async () => {
    const fixture = fakeSdk()
    await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'xai', model: 'grok-4.7' })
    expect(fixture.models[0]).toMatchObject({ contextWindow: 500_000, input: ['text', 'image'], cost: { input: 2, output: 6, cacheRead: 0.5 } })
    expect((await getXaiCatalogModels()).find((model) => model.id === 'grok-4.7')).toMatchObject({ contextWindow: 500_000, cost: { input: 2, output: 6, cacheRead: 0.5 } })
    const oauth = await buildXaiOAuthModel(fixture.sdk, {
      channelId: 'fixture', model: 'grok-4.7', xaiOAuthCredentials: { access: 'offline', refresh: 'offline', expires: 1 },
    }, {
      rememberXaiOAuthCredentials: (_id, credentials) => credentials,
      refreshXaiOAuthCredentialsSerial: async (_id, credentials) => credentials,
    })
    expect(oauth.model).toMatchObject({ id: 'grok-4.7', contextWindow: 500_000 })
  })

  test('Given MiniMax正式Flash与MiMo高速SKU When 注册 Then 大小写归一不丢属性', async () => {
    for (const [provider, model, cost] of [
      ['minimax', 'MiniMax-M3.1-Flash', { input: 0.15, output: 0.6, cacheRead: 0.015 }],
      ['xiaomi', 'mimo-v2.6-pro-ultraspeed', { input: 4.35, output: 8.7, cacheRead: 0.036 }],
    ] as const) {
      const fixture = fakeSdk()
      await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider, model })
      expect(fixture.models[0]).toMatchObject({ contextWindow: 1_000_000, input: ['text', 'image'], cost })
    }
  })

  test('Given 已公告Gemini12月调价 When 估算基础成本 Then 按生效日切换', () => {
    for (const id of ['gemini-4-carbon', 'gemini-4-argon']) {
      expect(resolveKnownPiModelMetadata(id, Date.parse('2026-11-30T23:59:59Z'))?.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 })
      expect(resolveKnownPiModelMetadata(id, Date.parse('2026-12-01T00:00:00Z'))?.cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 })
    }
  })

  test('Given 新型号 When 上下文UI兜底 Then 不再显示旧200K或错误1M', () => {
    expect(inferContextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(inferContextWindow('claude-haiku-4-5')).toBe(200_000)
    expect(inferContextWindow('gemini-4-hydrogen')).toBe(1_048_576)
    expect(inferContextWindow('qwen4-max')).toBe(1_000_000)
    expect(inferContextWindow('grok-4.7')).toBe(500_000)
    expect(supportsVerified1MContext('claude-haiku-5-5', 'anthropic')).toBe(true)
    expect(supportsVerified1MContext('claude-haiku-4-5', 'anthropic')).toBe(false)
  })
})

const offlineContext = normalizeContext({ messages: [{ role: 'user', content: 'offline', timestamp: 0 }] })
const offlineAbort = 'PROFER_REGISTERED_MODEL_PAYLOAD'

async function captureRegistered(provider: Parameters<typeof buildModel>[1]['provider'], model: string, reasoning?: ThinkingLevel, baseUrl = 'https://fixture.invalid/v1') {
  const fixture = fakeSdk()
  await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider, model, baseUrl })
  const registered = { ...fixture.models[0], provider: 'fixture', baseUrl } as Model<Api>
  const stream = registered.api === 'anthropic-messages' ? streamAnthropic : registered.api === 'google-generative-ai' ? streamGoogle : streamOpenAI
  let payload: unknown
  const result = await stream(registered as never, offlineContext, {
    apiKey: 'offline', reasoning, onPayload(value) { payload = value; throw new Error(offlineAbort) },
  }).result()
  expect(result.errorMessage).toContain(offlineAbort)
  return payload
}

describe('新型号注册后真实SDK请求（全离线）', () => {
  test('Given Claude新款及MiniMax When xhigh Then 发送原生xhigh而非旧max', async () => {
    for (const model of ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'MiniMax-M3.1-Flash']) {
      const provider = model.startsWith('MiniMax') ? 'minimax' : 'anthropic'
      expect(await captureRegistered(provider, model, 'xhigh')).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } })
    }
    expect(await captureRegistered('anthropic', 'claude-haiku-5-5')).toMatchObject({ thinking: { type: 'disabled' } })
  })

  test('Given Qwen4正式/Preview When medium/off Then 请求effort与预算准确', async () => {
    expect(await captureRegistered('qwen', 'qwen4-max', 'medium')).toMatchObject({ reasoning_effort: 'high', enable_thinking: true })
    expect(await captureRegistered('qwen', 'qwen4-max-preview', 'medium')).toMatchObject({ reasoning_effort: 'medium', enable_thinking: true })
    const off = await captureRegistered('qwen', 'qwen4-max') as Record<string, unknown>
    expect(off).toMatchObject({ enable_thinking: false })
    expect(off.max_tokens ?? off.max_completion_tokens).toBe(131_072)
    expect(await captureRegistered('qwen-anthropic', 'qwen4-max', 'medium')).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'high' }, max_tokens: 262_144 })
    expect(await captureRegistered('qwen-anthropic', 'qwen4-max')).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 131_072 })
  })

  test('Given Google新款 When 注册后选xhigh Then 真实生成XHIGH无budget', async () => {
    expect(await captureRegistered('google', 'gemini-4-hydrogen', 'xhigh')).toMatchObject({ config: { thinkingConfig: { thinkingLevel: 'XHIGH' } } })
  })

  test('Given MiMo2.6多轮工具历史 When 再请求 Then 完整回传非空reasoning_content', async () => {
    const fixture = fakeSdk()
    await buildFixture(fixture.sdk, { sessionId: 'refresh', apiKey: 'fixture-key', provider: 'custom', model: 'mimo-v2.6-pro' })
    const model = { ...fixture.models[0], provider: 'fixture' } as Model<'openai-completions'>
    const history = normalizeContext({ messages: [
      { role: 'user', content: '计算', timestamp: 0 },
      { role: 'assistant', provider: 'fixture', api: model.api, model: model.id, timestamp: 1,
        content: [{ type: 'thinking', thinking: '必须完整保留的历史推理', thinkingSignature: 'reasoning_content' }, { type: 'toolCall', id: 'call-1', name: 'calculate', arguments: {} }],
        stopReason: 'toolUse', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'calculate', content: [{ type: 'text', text: '2' }], isError: false, timestamp: 2 },
      { role: 'user', content: '接着算', timestamp: 3 },
    ] })
    let payload: unknown
    await streamOpenAI(model, history, { apiKey: 'offline', reasoning: 'high', onPayload(value) { payload = value; throw new Error(offlineAbort) } }).result()
    expect(payload).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant', reasoning_content: '必须完整保留的历史推理' })]) })
  })

  test('Given MiMo2.6与GLM Flash When OpenAI协议 Then 保留thinking开关与effort', async () => {
    const mimo = await captureRegistered('custom', 'mimo-v2.6-pro', 'high') as Record<string, unknown>
    expect(mimo).toMatchObject({ thinking: { type: 'enabled' } })
    expect(mimo).not.toHaveProperty('reasoning_effort')
    expect(await captureRegistered('zhipu', 'glm-5.3-flash', 'max')).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'max' })
  })
})
