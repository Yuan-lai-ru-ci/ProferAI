import { describe, expect, test } from 'bun:test'
import { getAdapter } from '@profer/core'
import { buildOneShotBody, resolveOneShotProtocol } from './retrospective-service'

/**
 * 回溯抽取的「一次性 LLM 调用」会把标题请求的骨架改写成 JSON 抽取请求。
 *
 * 历史缺陷：只按 `url.includes('/chat/completions')` 二分，Google 渠道
 * （`:generateContent`）与 Responses 渠道（`/responses`）都会落进 Anthropic 分支，
 * 被塞进 `system` + `messages` → Google 直接 400（未知字段）。
 * 这里锁住四种协议各自的最终请求体形态。
 */

const SYSTEM = 'system prompt'
const USER = 'user prompt'
const MAX = 8000

describe('buildOneShotBody：按协议改写一次性调用请求体', () => {
  test('Google 原生：system → systemInstruction，参数进 generationConfig，不残留非法顶层字段', () => {
    const skeleton = {
      contents: [{ role: 'user', parts: [{ text: 'title' }] }],
      generationConfig: { maxOutputTokens: 50 },
    }
    const body = buildOneShotBody(skeleton, 'google', SYSTEM, USER, MAX)

    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: USER }] }])
    expect(body.systemInstruction).toEqual({ parts: [{ text: SYSTEM }] })
    expect(body.generationConfig).toEqual({
      maxOutputTokens: MAX,
      temperature: 0,
      responseMimeType: 'application/json',
    })
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.messages).toBeUndefined()
    expect(body.system).toBeUndefined()
    expect(body.stream).toBeUndefined()
  })

  test('OpenAI Responses：system → instructions，上限用 max_output_tokens', () => {
    const skeleton = { model: 'grok-4', input: [{ role: 'user', content: 'title' }], max_output_tokens: 50, stream: false }
    const body = buildOneShotBody(skeleton, 'responses', SYSTEM, USER, MAX)

    expect(body.instructions).toBe(SYSTEM)
    expect(body.input).toEqual([{ role: 'user', content: USER }])
    expect(body.max_output_tokens).toBe(MAX)
    expect(body.max_tokens).toBeUndefined()
    expect(body.messages).toBeUndefined()
    expect(body.system).toBeUndefined()
  })

  test('Chat Completions：system 进 messages 首条并开 JSON 模式', () => {
    const skeleton = { model: 'gpt-5', messages: [{ role: 'user', content: 'title' }], max_tokens: 128, stream: false }
    const body = buildOneShotBody(skeleton, 'openai-chat', SYSTEM, USER, MAX)

    expect(body.messages).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ])
    expect(body.max_tokens).toBe(MAX)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.system).toBeUndefined()
    expect(body.contents).toBeUndefined()
  })

  test('Anthropic messages：system 是顶层字段，不带 response_format', () => {
    const skeleton = { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'title' }], max_tokens: 128, stream: false }
    const body = buildOneShotBody(skeleton, 'anthropic', SYSTEM, USER, MAX)

    expect(body.system).toBe(SYSTEM)
    expect(body.messages).toEqual([{ role: 'user', content: USER }])
    expect(body.max_tokens).toBe(MAX)
    expect(body.response_format).toBeUndefined()
    expect(body.instructions).toBeUndefined()
  })

  test('不改写入参骨架（避免调用方复用被污染）', () => {
    const skeleton = { contents: [{ role: 'user', parts: [{ text: 'title' }] }], generationConfig: { maxOutputTokens: 50 } }
    const snapshot = JSON.parse(JSON.stringify(skeleton))
    buildOneShotBody(skeleton, 'google', SYSTEM, USER, MAX)
    expect(skeleton).toEqual(snapshot)
  })
})

describe('resolveOneShotProtocol：协议跟随 Chat 适配器（含官方厂商端点覆盖）', () => {
  test('内置与 custom 渠道映射到各自协议', () => {
    expect(resolveOneShotProtocol(getAdapter('google'))).toBe('google')
    expect(resolveOneShotProtocol(getAdapter('openai-responses'))).toBe('responses')
    expect(resolveOneShotProtocol(getAdapter('anthropic'))).toBe('anthropic')
    expect(resolveOneShotProtocol(getAdapter('custom', undefined, 'https://gateway.example.com/v1'))).toBe('openai-chat')
  })

  test('custom 指向官方端点时与 Chat 适配器同步切换', () => {
    expect(resolveOneShotProtocol(getAdapter('custom', undefined, 'https://api.anthropic.com'))).toBe('anthropic')
    expect(resolveOneShotProtocol(getAdapter('custom', undefined, 'https://generativelanguage.googleapis.com'))).toBe('google')
    // Mistral 的 Chat 仍走 OpenAI 兼容，抽取请求体也随之保持 chat 形态
    expect(resolveOneShotProtocol(getAdapter('custom', undefined, 'https://api.mistral.ai/v1'))).toBe('openai-chat')
  })

  test('中转站域名不切换协议', () => {
    expect(resolveOneShotProtocol(getAdapter('custom', undefined, 'https://anthropic-relay.example.com/v1'))).toBe('openai-chat')
  })
})
