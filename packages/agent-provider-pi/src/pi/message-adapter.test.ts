import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import { convertPiMessage, convertResultMessage, EMPTY_IMAGE_PLACEHOLDER_TEXT, EMPTY_OUTPUT_ERROR_MESSAGE, hasTerminalErrorWithContent, installPiContextBudget, OMITTED_TOOL_IMAGE_TEXT, PERSISTED_TOOL_RESULT_PREFIX, sanitizePiContextMessages, sanitizePiContextMessagesWithImages, stripErrorFromContentMessage, TOOL_RESULT_BUDGET_MARKER, type PiContextTransformAgent } from './message-adapter'
import { createAgentRuntimeGuard } from '@profer/agent-runtime/runtime-guards'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { PiImageTranscoderPort } from '../ports'

function textAssistant(content: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    ...overrides,
  } as unknown as AssistantMessage
}

function thinkingOnlyAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '先分析，但没有生成正文' }],
    stopReason: 'stop',
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
  test('Given thinking-only final message When converting Then marks empty_output instead of success content', () => {
    const message = convertPiMessage(
      thinkingOnlyAssistant(),
      'session-empty-output',
      undefined,
      { final: true, uuid: 'assistant-empty-output' },
    ) as { error?: { message: string; errorType: string }; _emptyOutput?: boolean }

    expect(message.error).toEqual({ message: EMPTY_OUTPUT_ERROR_MESSAGE, errorType: 'empty_output' })
    expect(message._emptyOutput).toBe(true)
  })

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

  test('Given thinking-only final message When converting result Then subtype is execution error', () => {
    const result = convertResultMessage(
      [thinkingOnlyAssistant()],
      'session-empty-output',
    ) as { subtype?: string; terminal_reason?: string; errors?: string[] }

    expect(result.subtype).toBe('error_during_execution')
    expect(result.terminal_reason).toBe('empty_output')
    expect(result.errors).toEqual([EMPTY_OUTPUT_ERROR_MESSAGE])
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

  test('Given 正文只是错误文案副本 When 检测 Then 不冒充断流前有效正文', () => {
    const errorText = 'OpenAI 官方上游服务当前请求量较大，请稍后重试。'
    const message = convertPiMessage(
      textAssistant(errorText, {
        stopReason: 'error',
        errorMessage: errorText,
      }),
      'session-1',
      undefined,
      { final: true, uuid: 'assistant-duplicated-error' },
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

describe('sanitizePiContextMessages', () => {
  function assistantCalling(ids: string[]): AgentMessage {
    return {
      role: 'assistant',
      content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: {} })),
    } as unknown as AgentMessage
  }

  function bashResult(id: string, text: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text }],
    } as unknown as AgentMessage
  }

  test('空图像块被替换为文本占位，防止带空 data 的 image part 让上游挂起', () => {
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [
        { type: 'text', text: '已截取当前页面：profer-file://x/index.html' },
        { type: 'image', data: '', mimeType: 'image/png' },
      ],
    } as unknown as AgentMessage

    const result = sanitizePiContextMessages([toolResult])
    const sanitized = result[0]! as unknown as { content: Array<Record<string, unknown>> }

    expect(sanitized.content).toEqual([
      { type: 'text', text: '已截取当前页面：profer-file://x/index.html' },
      { type: 'text', text: EMPTY_IMAGE_PLACEHOLDER_TEXT },
    ])
    // 不修改原始消息对象
    expect((toolResult as unknown as { content: Array<Record<string, unknown>> }).content[1]!.data).toBe('')
  })

  test('非空图像与其余消息原样透传；无需改动时返回原数组引用', () => {
    const validImage = {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg', mimeType: 'image/png' }],
    } as unknown as AgentMessage
    const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as AgentMessage

    const messages = [validImage, user]
    const result = sanitizePiContextMessages(messages)

    expect(result).toBe(messages)
    expect(result[0]).toBe(validImage)
  })

  test('总文本超预算时整理旧组并保留头尾，最近两组（按 assistant 回复）保持完整', () => {
    const long = 'A'.repeat(80_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', long),
      assistantCalling(['recent-1']),
      bashResult('recent-1', long),
      assistantCalling(['recent-2']),
      bashResult('recent-2', long),
    ]

    const result = sanitizePiContextMessages(messages)
    const firstText = String(
      (result[1] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text,
    )

    expect(firstText.length).toBeLessThan(9_000)
    expect(firstText).toContain(TOOL_RESULT_BUDGET_MARKER)
    expect(firstText.startsWith('A')).toBe(true)
    expect(firstText.endsWith('A')).toBe(true)
    expect((result[3] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text).toBe(long)
    expect((result[5] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text).toBe(long)
  })

  test('同一条 assistant 回复的并行工具结果成组保留，不按条数劈开', () => {
    const long = 'P'.repeat(50_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', long),
      assistantCalling(['p1', 'p2', 'p3']),
      bashResult('p1', long),
      bashResult('p2', long),
      bashResult('p3', long),
      assistantCalling(['tail']),
      bashResult('tail', long),
    ]

    const result = sanitizePiContextMessages(messages)
    const textAt = (index: number) =>
      String((result[index] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text)

    // 只有最早那组被压缩；并行的 p1/p2/p3 同属一组，全部保留。
    expect(textAt(1).length).toBeLessThan(9_000)
    for (const index of [3, 4, 5, 7]) expect(textAt(index)).toBe(long)
  })

  test('内容本身包含预算标记字面量时超预算仍会被裁剪', () => {
    const embedded = `${TOOL_RESULT_BUDGET_MARKER} 已省略 123 个字符以节省上下文；如仍需完整内容，请重新调用工具或分页读取。]\n${'C'.repeat(210_000)}`
    const messages = [
      assistantCalling(['old']),
      bashResult('old', embedded),
      assistantCalling(['a']),
      bashResult('a', 'short-a'),
      assistantCalling(['b']),
      bashResult('b', 'short-b'),
    ]

    const result = sanitizePiContextMessages(messages)
    const firstText = String(
      (result[1] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text,
    )

    expect(firstText.length).toBeLessThan(9_000)
  })

  test('图片超过 6 张时成批整理旧图片并留出续轮空间', () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: 'toolResult',
      toolCallId: `call-image-${index}`,
      toolName: 'inspect_preview',
      isError: false,
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'a', mimeType: 'image/png' },
      ],
    })) as unknown as AgentMessage[]

    const result = sanitizePiContextMessages(messages)
    const images = result.reduce((count, message) => {
      const content = (message as unknown as { content: Array<Record<string, unknown>> }).content
      return count + content.filter((block) => block.type === 'image').length
    }, 0)

    // 第七张到来时整理到三张，第八张加入后共四张，未回填被省略的历史。
    expect(images).toBe(4)
    const firstContent = (result[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(firstContent.some((block) => block.type === 'text' && String(block.text).includes(OMITTED_TOOL_IMAGE_TEXT))).toBe(true)
    const lastContent = (result[7] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(lastContent.some((block) => block.type === 'image')).toBe(true)
  })

  test('聚合预算超出时把旧组原文落盘，消息里只留路径和预览', () => {
    const oldText = 'H'.repeat(120_000)
    const middleText = 'M'.repeat(120_000)
    const newestText = 'N'.repeat(120_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', oldText),
      assistantCalling(['mid']),
      bashResult('mid', middleText),
      assistantCalling(['new']),
      bashResult('new', newestText),
    ]
    const persisted: Array<{ toolCallId: string; text: string }> = []

    const result = sanitizePiContextMessages(messages, {
      sessionId: 'session-1',
      persist: {
        persist: (input) => {
          persisted.push({ toolCallId: input.toolCallId, text: input.text })
          return { path: `/tmp/${input.toolCallId}.txt` }
        },
      },
    })

    const firstText = String(
      (result[1] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text,
    )
    expect(firstText.startsWith(PERSISTED_TOOL_RESULT_PREFIX)).toBe(true)
    expect(firstText).toContain('/tmp/old.txt')
    // 落盘的是完整原文，不是 8k 截断版
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.toolCallId).toBe('old')
    expect(persisted[0]!.text).toBe(oldText)
    // 最近两组不受影响
    expect((result[3] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text).toBe(middleText)
    expect((result[5] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text).toBe(newestText)
  })

  test('没有落盘端口时退化为原地截断，请求不因缺少宿主能力而失败', () => {
    const huge = 'H'.repeat(120_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', huge),
      assistantCalling(['mid']),
      bashResult('mid', 'M'.repeat(120_000)),
      assistantCalling(['new']),
      bashResult('new', 'N'.repeat(120_000)),
    ]

    const result = sanitizePiContextMessages(messages, { sessionId: 'session-1' })
    const firstText = String(
      (result[1] as unknown as { content: Array<Record<string, unknown>> }).content[0]!.text,
    )

    expect(firstText.startsWith(PERSISTED_TOOL_RESULT_PREFIX)).toBe(false)
    expect(firstText).toContain(TOOL_RESULT_BUDGET_MARKER)
    expect(firstText.length).toBeLessThan(9_000)
  })

  test('落盘预览可重复处理，不会二次落盘', () => {
    const huge = 'H'.repeat(120_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', huge),
      assistantCalling(['mid']),
      bashResult('mid', 'M'.repeat(120_000)),
      assistantCalling(['new']),
      bashResult('new', 'N'.repeat(120_000)),
    ]
    const options = {
      sessionId: 'session-1',
      persist: { persist: () => ({ path: '/tmp/old.txt' }) },
    }

    const once = sanitizePiContextMessages(messages, options)
    let secondPassCalls = 0
    const twice = sanitizePiContextMessages(once, {
      sessionId: 'session-1',
      persist: {
        persist: () => {
          secondPassCalls += 1
          return { path: '/tmp/old.txt' }
        },
      },
    })

    expect(secondPassCalls).toBe(0)
    expect(twice).toEqual(once)
  })

  test('预算处理可重复执行，不会重复插入省略说明', () => {
    const long = 'B'.repeat(20_000)
    const messages = [
      assistantCalling(['old']),
      bashResult('old', long),
      assistantCalling(['a']),
      bashResult('a', long),
      assistantCalling(['b']),
      bashResult('b', long),
    ]

    const once = sanitizePiContextMessages(messages)
    const twice = sanitizePiContextMessages(once)

    expect(twice).toEqual(once)
  })
})

describe('sanitizePiContextMessagesWithImages', () => {
  function imageToolResult(index: number, data: string): AgentMessage {
    return {
      role: 'toolResult',
      toolCallId: `call-image-${index}`,
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data, mimeType: 'image/png' },
      ],
    } as unknown as AgentMessage
  }

  function imageCount(messages: AgentMessage[]): number {
    return messages.reduce((count, message) => {
      const content = (message as unknown as { content: Array<Record<string, unknown>> }).content
      if (!Array.isArray(content)) return count
      return count + content.filter((block) => block.type === 'image').length
    }, 0)
  }

  test('预算内图片使用稳定高清档，不随新增图片滑动改变旧图编码', async () => {
    const calls: Array<{ maxSide: number; quality: number }> = []
    const transcoder: PiImageTranscoderPort = {
      async transcode(_input, options) {
        calls.push({ maxSide: options.maxSide, quality: options.quality })
        return { data: 'B'.repeat(100), mimeType: 'image/jpeg' }
      },
    }
    const messages = Array.from({ length: 6 }, (_, index) => imageToolResult(index, 'A'.repeat(1_000)))

    const result = await sanitizePiContextMessagesWithImages(messages, transcoder)

    expect(calls.map((call) => call.maxSide)).toEqual([1600, 1600, 1600, 1600, 1600, 1600])
    expect(calls.map((call) => call.quality)).toEqual([82, 82, 82, 82, 82, 82])
    expect(imageCount(result)).toBe(6)
    // 不修改原始消息对象。
    const originalContent = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(originalContent.find((block) => block.type === 'image')!.data).toBe('A'.repeat(1_000))
  })

  test('超过 6 张时成批省略旧图，最新图片仍保留', async () => {
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        return { data: 'B'.repeat(100), mimeType: 'image/jpeg' }
      },
    }
    const messages = Array.from({ length: 8 }, (_, index) => imageToolResult(index, 'A'.repeat(1_000)))

    const result = await sanitizePiContextMessagesWithImages(messages, transcoder)

    expect(imageCount(result)).toBe(4)
    const oldest = (result[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(oldest.some((block) => block.type === 'text' && String(block.text).includes(OMITTED_TOOL_IMAGE_TEXT))).toBe(true)
  })

  test('总 base64 字节超预算时从最旧保留图开始省略', async () => {
    const twoMb = 'A'.repeat(2 * 1024 * 1024)
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        // 模拟“压不动”的图：总预算只能靠省略旧图兜底。
        return { data: twoMb, mimeType: 'image/jpeg' }
      },
    }
    const messages = Array.from({ length: 6 }, (_, index) => imageToolResult(index, twoMb))

    const result = await sanitizePiContextMessagesWithImages(messages, transcoder)

    // 6MB / 2MB = 3 张；更旧的 3 张被省略。
    expect(imageCount(result)).toBe(3)
    const oldest = (result[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(oldest.some((block) => block.type === 'text' && String(block.text).includes(OMITTED_TOOL_IMAGE_TEXT))).toBe(true)
  })

  test('没有转码器时退化为张数裁剪，不会因缺少宿主能力而报错', async () => {
    const messages = Array.from({ length: 8 }, (_, index) => imageToolResult(index, 'A'.repeat(1_000)))

    const result = await sanitizePiContextMessagesWithImages(messages)

    expect(imageCount(result)).toBe(4)
  })

  test('同一原始图片跨轮复用转码缓存，不重复编码', async () => {
    let calls = 0
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        calls += 1
        return { data: 'B'.repeat(100), mimeType: 'image/jpeg' }
      },
    }
    const messages = [imageToolResult(0, 'A'.repeat(1_000))]

    await sanitizePiContextMessagesWithImages(messages, transcoder)
    await sanitizePiContextMessagesWithImages(messages, transcoder)

    expect(calls).toBe(1)
  })

  test('user 消息中的 image block 也纳入预算', async () => {
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        return { data: 'B'.repeat(100), mimeType: 'image/jpeg' }
      },
    }
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', data: 'A'.repeat(1_000), mimeType: 'image/png' },
      ],
    }] as unknown as AgentMessage[]

    const result = await sanitizePiContextMessagesWithImages(messages, transcoder)
    const content = (result[0] as unknown as { content: Array<Record<string, unknown>> }).content
    const image = content.find((block) => block.type === 'image')

    expect(image).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(image!.data).toBe('B'.repeat(100))
  })

  test('转码器抛错时保留原图，不阻断下一轮请求', async () => {
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        throw new Error('transcode failed')
      },
    }
    const messages = Array.from({ length: 2 }, (_, index) => imageToolResult(index, 'A'.repeat(1_000)))

    const result = await sanitizePiContextMessagesWithImages(messages, transcoder)

    expect(imageCount(result)).toBe(2)
  })
})

describe('installPiContextBudget', () => {
  test('挂到 transformContext 并链式执行原 transform；首轮请求也会经过压缩', async () => {
    const calls: string[] = []
    const transcoder: PiImageTranscoderPort = {
      async transcode() {
        return { data: 'B'.repeat(100), mimeType: 'image/jpeg' }
      },
    }
    const agent: PiContextTransformAgent = {
      transformContext: async (messages) => {
        calls.push('previous')
        return messages
      },
    }
    installPiContextBudget(agent, transcoder)

    const messages = [{
      role: 'toolResult',
      toolCallId: 'call-first-turn',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [{ type: 'image', data: 'A'.repeat(1_000), mimeType: 'image/png' }],
    }] as unknown as AgentMessage[]
    const transformed = await agent.transformContext!(messages)

    expect(calls).toEqual(['previous'])
    const content = (transformed[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(content[0]!.data).toBe('B'.repeat(100))
  })

  test('没有原 transform 时直接压缩，不要求宿主额外接线', async () => {
    const agent: PiContextTransformAgent = {}
    installPiContextBudget(agent)
    const messages = [{
      role: 'toolResult',
      toolCallId: 'call-no-transform',
      toolName: 'BrowserScreenshot',
      isError: false,
      content: [{ type: 'image', data: '', mimeType: 'image/png' }],
    }] as unknown as AgentMessage[]

    const transformed = await agent.transformContext!(messages)
    const content = (transformed[0] as unknown as { content: Array<Record<string, unknown>> }).content
    expect(content[0]).toEqual({ type: 'text', text: EMPTY_IMAGE_PLACEHOLDER_TEXT })
  })
})

// 这条往返断言原先在 packages/agent-runtime/src/runtime-guards.test.ts，随 provider 切出时被移除。
// 核心现在只锁定自己承诺的 override 契约（terminalReason），从 override 到 Pi result 消息的字段映射
// （terminalReason → terminal_reason、subtype、session_id）只能由 provider 侧覆盖，否则该边界无人守。
describe('guard override → Pi result message 往返', () => {
  test('Given max_turns 守卫 override When converting the result Then terminal fields round-trip', () => {
    const guard = createAgentRuntimeGuard({ maxTurns: 1 })
    guard.recordMessage(textAssistant('first turn'))
    const override = guard.getLimitResultOverride()
    expect(override).toMatchObject({ subtype: 'error_max_turns', terminalReason: 'max_turns' })

    const result = convertResultMessage([], 'session-limit', override) as unknown as {
      type: string
      subtype: string
      terminal_reason: string
      session_id: string
    }
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error_max_turns',
      terminal_reason: 'max_turns',
      session_id: 'session-limit',
    })
  })

  test('Given 没有 override When converting the result Then terminal_reason 由消息自身推导', () => {
    const result = convertResultMessage([textAssistant('done')], 'session-ok') as unknown as {
      subtype: string
      terminal_reason: string
      session_id: string
    }
    expect(result).toMatchObject({ subtype: 'success', terminal_reason: 'completed', session_id: 'session-ok' })
  })
})
