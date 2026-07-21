import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONTEXT_WINDOW, ONE_MILLION_CONTEXT_WINDOW } from '@profer/shared'
import type { SDKResultMessage } from '@profer/shared'
import { pickResultContextWindow } from './agent-session-usage'

function resultWithUsage(
  modelUsage: SDKResultMessage['modelUsage'],
  channelModelId?: string,
): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage,
    _channelModelId: channelModelId,
  }
}

describe('automation session result 上下文窗口选择', () => {
  test('Given 子模型排在第一项 When result 保存了主模型 ID Then 选择主模型窗口', () => {
    const result = resultWithUsage({
      'small-subagent': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'gateway/deepseek-v4-pro': { contextWindow: ONE_MILLION_CONTEXT_WINDOW },
    }, 'gateway/deepseek-v4-pro[1m]')

    expect(pickResultContextWindow(result)).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('Given 历史 result 没有主模型 ID When 多模型 usage 存在 Then 使用最大窗口稳健兜底', () => {
    const result = resultWithUsage({
      'small-subagent': { contextWindow: DEFAULT_CONTEXT_WINDOW },
      'larger-model': { contextWindow: 400_000 },
    })

    expect(pickResultContextWindow(result)).toBe(400_000)
  })
})
