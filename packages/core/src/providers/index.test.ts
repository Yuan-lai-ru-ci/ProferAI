import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@profer/shared'
import { getAdapter, resolveTitleBaseUrl } from './index.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'

describe('provider adapter instances', () => {
  test('每次获取 Anthropic adapter 都是独立实例，避免流式 block 状态跨请求污染', () => {
    expect(getAdapter('anthropic')).not.toBe(getAdapter('anthropic'))
  })

  test('每次获取 Google adapter 都是独立实例，避免工具计数器跨请求污染', () => {
    expect(getAdapter('google')).not.toBe(getAdapter('google'))
  })

  test('xAI 渠道按 apiProtocol 选择 Chat 适配器，第三方中转可走 Chat Completions', () => {
    expect(getAdapter('xai')).toBeInstanceOf(OpenAIResponsesAdapter)
    expect(getAdapter('xai', 'chat-completions')).toBeInstanceOf(OpenAIAdapter)
    const request = getAdapter('xai', 'chat-completions').buildStreamRequest({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'fixture-key',
      modelId: 'grok-4.3',
      history: [],
      userMessage: 'hi',
      readImageAttachments: () => [],
    })
    expect(request.url).toBe('https://relay.example.com/v1/chat/completions')
  })

  test('完整 /responses 端点覆盖 OpenAI 兼容渠道的静态协议', () => {
    // 第三方网关（CLIProxyAPI / Codex 反代）用户常把文档里的完整端点直接填进渠道。
    // 若仍按 Chat Completions 发 messages 请求体，网关会回 200 + 空流。
    const adapter = getAdapter('custom', undefined, 'https://codex.diraw.top/v1/responses')
    expect(adapter).toBeInstanceOf(OpenAIResponsesAdapter)
    const request = adapter.buildStreamRequest({
      baseUrl: 'https://codex.diraw.top/v1/responses',
      apiKey: 'fixture-key',
      modelId: 'gpt-6-luna',
      history: [],
      userMessage: 'hi',
      readImageAttachments: () => [],
    })
    expect(request.url).toBe('https://codex.diraw.top/v1/responses')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body.input).toBeDefined()
    expect(body.messages).toBeUndefined()
    expect(body.stream).toBe(true)
  })

  test('协议根地址不会被误判为 Responses', () => {
    expect(getAdapter('custom', undefined, 'https://gateway.example.com/v1')).toBeInstanceOf(OpenAIAdapter)
    expect(getAdapter('openai', undefined, 'https://api.openai.com/v1')).toBeInstanceOf(OpenAIAdapter)
  })

  test('23 种 Provider：22 个 Chat adapter 与 Pi-only Codex 边界', () => {
    const providers: ProviderType[] = [
      'anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'deepseek', 'google',
      'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team',
      'ark-coding-plan', 'minimax', 'doubao', 'qwen', 'qwen-anthropic', 'xiaomi', 'xiaomi-token-plan',
      'openai-codex', 'xai', 'ollama', 'custom',
    ]
    expect(providers).toHaveLength(23)
    for (const provider of providers.filter((item) => item !== 'openai-codex')) expect(() => getAdapter(provider)).not.toThrow()
    expect(() => getAdapter('openai-codex')).toThrow('不支持的供应商')
  })
})

describe('resolveTitleBaseUrl', () => {
  test('custom 渠道填了完整 /responses 端点时，标题与主链路一样回到协议根', () => {
    // 主链路（Pi）会剥掉 /responses 再拼 /chat/completions；标题请求必须落同一个地址，
    // 否则会把 Chat Completions 请求体 POST 到 Responses 端点，被网关拒绝后静默回退。
    expect(resolveTitleBaseUrl('custom', 'https://gateway.example.com/v1/responses')).toBe(
      'https://gateway.example.com/v1',
    )
    expect(getAdapter('custom').buildTitleRequest({
      baseUrl: resolveTitleBaseUrl('custom', 'https://gateway.example.com/v1/responses') ?? '',
      apiKey: 'fixture-key',
      modelId: 'fixture-model',
      prompt: 'fixture',
    }).url).toBe('https://gateway.example.com/v1/chat/completions')
  })

  test('custom 完整 /chat/completions 端点还原成协议根，不重复拼接', () => {
    expect(resolveTitleBaseUrl('custom', 'https://gateway.example.com/v1/chat/completions')).toBe(
      'https://gateway.example.com/v1',
    )
  })

  test('协议根与自定义路由保持既有语义', () => {
    expect(resolveTitleBaseUrl('custom', 'https://gateway.example.com/v1')).toBe(
      'https://gateway.example.com/v1',
    )
    expect(resolveTitleBaseUrl('custom', 'https://gateway.example.com/v1/proxy/chat')).toBe(
      'https://gateway.example.com/v1/proxy/chat',
    )
  })

  test('Anthropic 与 OAuth 订阅渠道不参与 OpenAI 端点归一化', () => {
    expect(resolveTitleBaseUrl('anthropic', 'https://gateway.example.com/v1/responses')).toBe(
      'https://gateway.example.com/v1/responses',
    )
    expect(resolveTitleBaseUrl('xai', 'https://gateway.example.com/v1/responses')).toBe(
      'https://gateway.example.com/v1/responses',
    )
  })

  test('xAI 切到 Chat Completions 后标题端点跟随协议归一化', () => {
    expect(resolveTitleBaseUrl('xai', 'https://gateway.example.com/v1/responses', 'chat-completions')).toBe(
      'https://gateway.example.com/v1',
    )
    expect(resolveTitleBaseUrl('xai', 'https://gateway.example.com/v1/chat/completions', 'chat-completions')).toBe(
      'https://gateway.example.com/v1',
    )
  })

  test('空地址保持空值语义', () => {
    expect(resolveTitleBaseUrl('custom', '')).toBe('')
    expect(resolveTitleBaseUrl('custom', undefined)).toBeUndefined()
  })
})
