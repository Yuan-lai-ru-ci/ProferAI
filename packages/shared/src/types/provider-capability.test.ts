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
