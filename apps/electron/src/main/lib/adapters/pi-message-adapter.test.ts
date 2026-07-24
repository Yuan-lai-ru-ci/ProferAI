import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { convertPiMessage, convertResultMessage, hasTerminalErrorWithContent, stripErrorFromContentMessage } from './pi-message-adapter'

function textAssistant(content: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    ...overrides,
  } as unknown as AssistantMessage
}

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

  // #1267: 流式断连应被识别为 network_error 而非 provider_error
  test('Given chunked read 流式断连错误 When 终态 Then errorType 为 network_error', () => {
    const message = convertPiMessage(
      textAssistant('这是一段正常的助手回复内容', {
        stopReason: 'error',
        errorMessage: 'incomplete chunked read',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-1' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('network_error')
    expect(message.error!.message).toBe('incomplete chunked read')
  })

  test('Given peer closed 断连错误 When 终态 Then errorType 为 network_error', () => {
    const message = convertPiMessage(
      textAssistant('部分回复', {
        stopReason: 'error',
        errorMessage: 'peer closed connection',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-2' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('network_error')
  })

  test('Given provider 业务错误 When 终态 Then errorType 仍为 provider_error', () => {
    const message = convertPiMessage(
      textAssistant('部分回复', {
        stopReason: 'error',
        errorMessage: 'invalid api key',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-3' },
    ) as { error?: { message: string; errorType: string } }

    expect(message.error).toBeDefined()
    expect(message.error!.errorType).toBe('provider_error')
  })

  // #1268: 断流保消息 — content + error 分离
  test('Given 带正文的终端错误 When 分离 Then 返回不含 error 的正文消息和错误文本', () => {
    const textContent = '这是回复的前半部分，正在处理中...'
    const message = convertPiMessage(
      textAssistant(textContent, {
        stopReason: 'error',
        errorMessage: 'stream ended before terminal response event',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-sep' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(true)

    const separated = stripErrorFromContentMessage(message!)
    expect(separated).not.toBeNull()
    expect(separated!.errorText).toBe('stream ended before terminal response event')
    // 正文消息不含 error 字段
    expect((separated!.contentMessage as Record<string, unknown>).error).toBeUndefined()
    // 正文消息保留了原始 uuid
    expect((separated!.contentMessage as Record<string, unknown>).uuid).toBe('assistant-sep')
    // 正文消息保留文本内容
    const content = (separated!.contentMessage as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
    expect(content).toBeDefined()
    expect(content![0]?.text).toBe(textContent)
  })

  test('Given 纯错误（无正文）When 检测 Then 不判定为 terminal error with content', () => {
    const message = convertPiMessage(
      textAssistant('', {
        stopReason: 'error',
        errorMessage: 'invalid api key',
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-no-content' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(false)
    expect(stripErrorFromContentMessage(message!)).toBeNull()
  })

  test('Given 正常消息（无错误）When 检测 Then 不判定为 terminal error with content', () => {
    const message = convertPiMessage(
      textAssistant('正常回复内容'),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-normal' },
    )

    expect(hasTerminalErrorWithContent(message!)).toBe(false)
    expect(stripErrorFromContentMessage(message!)).toBeNull()
  })
})
