import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { convertPiMessage, convertResultMessage } from './pi-message-adapter'

function writeToolCall(content: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as AssistantMessage
}

describe('convertPiMessage', () => {
  test('omits cumulative write content from partial tool-call frames', () => {
    const message = convertPiMessage(writeToolCall('x'.repeat(10_240)), 'session-1', undefined, {
      final: false,
      uuid: 'assistant-1',
    }) as { _partial?: boolean; message: { content: Array<{ input?: unknown }> } }

    expect(message._partial).toBe(true)
    expect(message.message.content[0]?.input).toEqual({})
    expect(JSON.stringify(message).length).toBeLessThan(1_000)
  })

  test('keeps complete write input in the final tool-call frame', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1', undefined, {
      final: true,
      uuid: 'assistant-1',
    }) as { message: { content: Array<{ input?: Record<string, unknown> }> } }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.proma\\agent-workspaces\\moneybull\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('Given Pi 剥离 SDK 后缀 When 持久化 result Then 保存真实窗口、请求模型和渠道主模型', () => {
    const result = convertResultMessage(
      [],
      'session-1',
      undefined,
      1_000_000,
      'gateway/deepseek-v4-pro',
      'gateway/deepseek-v4-pro[1m]',
    ) as {
      modelUsage?: Record<string, { contextWindow?: number }>
      _channelModelId?: string
    }

    expect(result.modelUsage).toEqual({
      'gateway/deepseek-v4-pro': { contextWindow: 1_000_000 },
    })
    expect(result._channelModelId).toBe('gateway/deepseek-v4-pro[1m]')
  })
})
