import { describe, expect, test } from 'bun:test'
import { injectMistralReasoningLevel, createMistralReasoningRequestExtension } from './mistral-reasoning-request-settings'

describe('Mistral 原生推理参数改写', () => {
  test('Given Pi 给 deepseek 模型补了 promptMode When 会话开启思考 Then 改成 reasoningEffort=high', () => {
    // before_provider_request 看到的是序列化前的 camelCase payload。
    const payload = { model: 'deepseek-v4-1-flash-1017', messages: [], promptMode: 'reasoning' }
    const updated = injectMistralReasoningLevel(payload, { thinkingLevel: 'high' })
    expect(updated).toEqual({ model: 'deepseek-v4-1-flash-1017', messages: [], reasoningEffort: 'high' })
  })

  test('Given 中间档位 When 改写 Then 收敛到 Mistral 唯一支持的 high', () => {
    const updated = injectMistralReasoningLevel({ model: 'magistral-medium-latest', promptMode: 'reasoning' }, { thinkingLevel: 'medium' })
    expect(updated).toMatchObject({ reasoningEffort: 'high' })
    expect(updated).not.toHaveProperty('promptMode')
  })

  test('Given 关闭思考 When 请求体已有推理字段 Then 两个字段都被移除', () => {
    const updated = injectMistralReasoningLevel({ model: 'magistral-medium-latest', promptMode: 'reasoning', reasoningEffort: 'high' }, { thinkingLevel: 'off' })
    expect(updated).toEqual({ model: 'magistral-medium-latest' })
  })

  test('Given 关闭思考且没有推理字段 When 改写 Then 返回原对象，不产生无意义的新请求体', () => {
    const payload = { model: 'mistral-medium-latest', messages: [] }
    expect(injectMistralReasoningLevel(payload, { thinkingLevel: 'off' })).toBe(payload)
  })

  test('Given 已在 reasoningEffort=high When 改写 Then 保持原对象', () => {
    const payload = { model: 'mistral-medium-latest', reasoningEffort: 'high' }
    expect(injectMistralReasoningLevel(payload, { thinkingLevel: 'high' })).toBe(payload)
  })

  test('Given 序列化后的 snake_case 请求体 When 改写 Then 同样按 wire 字段改写（防御路径）', () => {
    const updated = injectMistralReasoningLevel({ model: 'deepseek-v4-1-flash-1017', prompt_mode: 'reasoning' }, { thinkingLevel: 'high' })
    expect(updated).toEqual({ model: 'deepseek-v4-1-flash-1017', reasoning_effort: 'high' })
  })

  test('Given 未声明推理能力的模型 When 改写 Then 不碰请求体', () => {
    const payload = { model: 'codestral-latest', promptMode: 'reasoning' }
    expect(injectMistralReasoningLevel(payload, { thinkingLevel: 'high' })).toBe(payload)
  })

  test('Given 非对象请求体 When 改写 Then 原样返回', () => {
    expect(injectMistralReasoningLevel('not-a-body', { thinkingLevel: 'high' })).toBe('not-a-body')
  })

  test('Given 没有会话级档位 When 改写 Then 不把未指定当成开启思考', () => {
    const payload = { model: 'deepseek-v4-1-flash-1017', promptMode: 'reasoning' }
    expect(injectMistralReasoningLevel(payload, {})).toBe(payload)
  })

  test('Given 注册扩展 When 收到 provider 请求事件 Then 改写后的请求体被返回', () => {
    const handlers: Array<{ name: string; handler: (event: { payload: unknown }) => unknown }> = []
    const pi = { on: (name: string, handler: (event: { payload: unknown }) => unknown) => { handlers.push({ name, handler }) } }
    createMistralReasoningRequestExtension({ thinkingLevel: 'high' })(pi as never)

    expect(handlers).toHaveLength(1)
    expect(handlers[0]!.name).toBe('before_provider_request')
    expect(handlers[0]!.handler({ payload: { model: 'magistral-medium-latest', promptMode: 'reasoning' } }))
      .toEqual({ model: 'magistral-medium-latest', reasoningEffort: 'high' })
    // 无需改写的请求返回 undefined，避免 Pi 以为请求被改写。
    expect(handlers[0]!.handler({ payload: { model: 'codestral-latest' } })).toBeUndefined()
  })
})
