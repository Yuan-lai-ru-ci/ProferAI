import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { nextContextUsageReading as next } from './agent-context-usage-reading'

const assistant: SDKMessage = { type: 'assistant', parent_tool_use_id: null, message: { content: [], model: 'primary', usage: { input_tokens: 11, cache_read_input_tokens: 200, cache_creation_input_tokens: 20, output_tokens: 7 } } }
const result: SDKMessage = { type: 'result', subtype: 'success', num_turns: 3, _channelModelId: 'primary', modelUsage: { worker: { contextWindow: 7000 }, primary: { contextWindow: 2000 } }, usage: { input_tokens: 900, output_tokens: 99 } }

describe('主进程采集上下文读数', () => {
  test('记录主调用的实际输入和当时的窗口、时间；累计 result 只校准分母', () => {
    const reading = next(undefined, assistant, 1000, 100)
    expect(reading).toEqual({ inputTokens: 231, cacheReadTokens: 200, cacheCreationTokens: 20, outputTokens: 7, model: 'primary', usageUpdatedAt: 100, contextWindow: 1000 })
    if (!reading) throw new Error('主调用未生成读数')
    expect(next(reading, result, 1000, 300)).toEqual({ ...reading, contextWindow: 2000 })
  })
  test('没有主调用数据时，累计/未知轮数和多模型 result 不是有效快照', () => {
    expect(next(undefined, result, 1000, 100)).toBeUndefined()
    expect(next(undefined, { ...result, num_turns: undefined }, 1000, 100)).toBeUndefined()
    expect(next(undefined, { ...result, num_turns: 1 }, 1000, 100)).toBeUndefined()
    expect(next(undefined, { ...result, num_turns: 1, modelUsage: { primary: { contextWindow: 1200 } } }, 1000, 100)?.inputTokens).toBe(900)
  })
  test('跳过子调用、重放、错误和没有有效输入的占位', () => {
    for (const extra of [{ parent_tool_use_id: 'sub' }, { isReplay: true }, { error: { message: 'x', errorType: 'x' } }, { message: { content: [], usage: { input_tokens: 0 } } }, { message: { content: [], usage: { input_tokens: -7, cache_read_input_tokens: 90 } } }]) {
      expect(next(undefined, { ...assistant, ...extra } as SDKMessage, 1000, 100)).toBeUndefined()
    }
  })
})
