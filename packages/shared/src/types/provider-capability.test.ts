import { describe, expect, test } from 'bun:test'
import { isResponsesShapedEndpoint, resolveProviderNativeProtocol } from './provider-capability'

describe('isResponsesShapedEndpoint', () => {
  test('识别完整 /responses 端点（含尾斜杠、query、缺 scheme）', () => {
    expect(isResponsesShapedEndpoint('https://codex.diraw.top/v1/responses')).toBe(true)
    expect(isResponsesShapedEndpoint('https://codex.diraw.top/v1/responses/')).toBe(true)
    expect(isResponsesShapedEndpoint('https://codex.diraw.top/v1/responses?x=1')).toBe(true)
    expect(isResponsesShapedEndpoint('codex.diraw.top/v1/responses')).toBe(true)
  })

  test('协议根与 Chat Completions 端点不算 Responses', () => {
    expect(isResponsesShapedEndpoint('https://codex.diraw.top/v1')).toBe(false)
    expect(isResponsesShapedEndpoint('https://codex.diraw.top/v1/chat/completions')).toBe(false)
    expect(isResponsesShapedEndpoint('')).toBe(false)
    expect(isResponsesShapedEndpoint(undefined)).toBe(false)
  })
})

describe('resolveProviderNativeProtocol：端点形态覆盖静态归属', () => {
  test('custom / openai 渠道填完整 /responses 端点时按 Responses 协议', () => {
    expect(resolveProviderNativeProtocol('custom', 'https://codex.diraw.top/v1/responses')).toBe('openai-responses')
    expect(resolveProviderNativeProtocol('openai', 'https://codex.diraw.top/v1/responses')).toBe('openai-responses')
  })

  test('协议根仍走静态归属，不误伤普通 OpenAI 兼容渠道', () => {
    expect(resolveProviderNativeProtocol('custom', 'https://gateway.example.com/v1')).toBe('openai-completions')
    expect(resolveProviderNativeProtocol('openai', 'https://api.openai.com/v1')).toBe('openai-completions')
  })

  test('既有嗅探规则不受影响', () => {
    expect(resolveProviderNativeProtocol('deepseek', 'https://relay.example.com/v1')).toBe('openai-completions')
    expect(resolveProviderNativeProtocol('ollama', 'http://127.0.0.1:11434')).toBe('anthropic-messages')
    expect(resolveProviderNativeProtocol('xai', 'https://relay.example.com/v1', 'chat-completions')).toBe('openai-completions')
    expect(resolveProviderNativeProtocol('openai-responses', 'https://gateway.example.com/v1')).toBe('openai-responses')
  })
})

describe('resolveProviderNativeProtocol：官方厂商端点切原生协议', () => {
  test('官方 Mistral / Anthropic / Google 端点命中各自原生协议', () => {
    expect(resolveProviderNativeProtocol('custom', 'https://api.mistral.ai/v1')).toBe('mistral-conversations')
    expect(resolveProviderNativeProtocol('custom', 'https://api.mistral.ai')).toBe('mistral-conversations')
    expect(resolveProviderNativeProtocol('custom', 'https://api.anthropic.com')).toBe('anthropic-messages')
    expect(resolveProviderNativeProtocol('custom', 'https://api.anthropic.com/v1/messages')).toBe('anthropic-messages')
    expect(resolveProviderNativeProtocol('custom', 'https://generativelanguage.googleapis.com')).toBe('google-generative-ai')
    expect(resolveProviderNativeProtocol('openai', 'https://api.mistral.ai/v1')).toBe('mistral-conversations')
  })

  test('中转站域名即使带厂商关键词也保持 OpenAI 兼容（连通性零回归）', () => {
    for (const relay of [
      'https://mistral-relay.example.com/v1',
      'https://api.mistral.ai.proxy.example.com/v1',
      'https://mistral.example.com/v1',
      'https://anthropic-relay.example.com/v1',
      'https://api.anthropic.com.relay.example.com/v1',
      'https://google-relay.example.com/v1',
      'https://gateway.example.com/v1',
    ]) {
      expect(resolveProviderNativeProtocol('custom', relay)).toBe('openai-completions')
    }
    expect(resolveProviderNativeProtocol('custom', undefined)).toBe('openai-completions')
  })

  test('Google 的官方 OpenAI 兼容层路径不切协议', () => {
    expect(resolveProviderNativeProtocol('custom', 'https://generativelanguage.googleapis.com/v1beta/openai'))
      .toBe('openai-completions')
    expect(resolveProviderNativeProtocol('custom', 'https://generativelanguage.googleapis.com/v1beta/openai/'))
      .toBe('openai-completions')
  })

  test('非官方厂商与专用 provider 的静态归属不变', () => {
    expect(resolveProviderNativeProtocol('custom', 'https://api.deepseek.com/v1')).toBe('openai-completions')
    expect(resolveProviderNativeProtocol('custom', 'https://openrouter.ai/api/v1')).toBe('openai-completions')
    expect(resolveProviderNativeProtocol('anthropic', 'https://relay.example.com/v1')).toBe('anthropic-messages')
    expect(resolveProviderNativeProtocol('google', 'https://generativelanguage.googleapis.com')).toBe('google-generative-ai')
    // 裸域名（缺 scheme）也要识别
    expect(resolveProviderNativeProtocol('custom', 'api.mistral.ai/v1')).toBe('mistral-conversations')
  })
})
