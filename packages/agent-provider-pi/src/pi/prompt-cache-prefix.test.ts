import { describe, expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { PiImageTranscoderPort } from '../ports'
import { sanitizePiContextMessages, sanitizePiContextMessagesWithImages } from './message-adapter'

function toolGroup(id: string, text: string): AgentMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `${id}.txt` } }] },
    { role: 'toolResult', toolCallId: id, toolName: 'read', isError: false, content: [{ type: 'text', text }] },
  ] as AgentMessage[]
}

function screenshot(index: number): AgentMessage {
  return {
    role: 'toolResult', toolCallId: `image-${index}`, toolName: 'BrowserScreenshot', isError: false,
    content: [{ type: 'image', data: `original-${index}-${'A'.repeat(1_000)}`, mimeType: 'image/png' }],
  } as AgentMessage
}

const transcoder: PiImageTranscoderPort = {
  async transcode(input, options) {
    return { data: `${input.data.slice(0, 10)}-${options.maxSide}`, mimeType: 'image/jpeg' }
  },
}

function textAt(messages: AgentMessage[], index: number): string {
  return (messages[index] as { content: Array<{ text: string }> }).content[0]!.text
}

describe('Pi 请求历史的缓存前缀稳定性', () => {
  test('Given 工具文本总量未超限 When 加入第三组 Then 前两组请求内容保持不变', async () => {
    const history = [...toolGroup('one', 'A'.repeat(20_000)), ...toolGroup('two', 'B'.repeat(20_000))]
    const before = await sanitizePiContextMessagesWithImages(history)
    const after = await sanitizePiContextMessagesWithImages([...history, ...toolGroup('three', 'short')])
    expect(after.slice(0, history.length)).toEqual(before)
    expect(textAt(after, 1)).toHaveLength(20_000)
    expect(textAt(history, 1)).toHaveLength(20_000)
  })

  test('Given 历史已触发预算整理 When 增加小结果或重新加载历史 Then 既有请求表示不恢复也不继续滑动截断', async () => {
    const history = Array.from({ length: 12 }, (_, index) => toolGroup(`read-${index}`, String(index).repeat(20_000))).flat()
    const before = await sanitizePiContextMessagesWithImages(history)
    const longerHistory = [...history, ...toolGroup('tail', 'short')]
    const after = await sanitizePiContextMessagesWithImages(longerHistory)
    expect(after.slice(0, history.length)).toEqual(before)
    // 模拟进程重启后从 JSONL 重建对象，不能依赖 WeakMap/对象身份保存预算决策。
    const restored = await sanitizePiContextMessagesWithImages(JSON.parse(JSON.stringify(longerHistory)))
    expect(restored).toEqual(after)
    const totalText = after.reduce((sum, message) => message.role === 'toolResult'
      ? sum + (message.content as Array<{ text: string }>).reduce((count, block) => count + (block.text?.length ?? 0), 0)
      : sum, 0)
    expect(totalText).toBeLessThanOrEqual(200_000)
  })

  test('Given 预算内两张图片 When 加入第三张 Then 第一张不会因变旧而重新编码', async () => {
    const history = [screenshot(0), screenshot(1)]
    const before = await sanitizePiContextMessagesWithImages(history, transcoder)
    const after = await sanitizePiContextMessagesWithImages([...history, screenshot(2)], transcoder)
    expect(after.slice(0, history.length)).toEqual(before)
    expect(JSON.stringify(after[0])).toContain('1600')
  })

  test('Given 同一工具返回八张图 When 超限整理 Then 同步和异步都保留相同的最近图片', async () => {
    const message = screenshot(0)
    const images = Array.from({ length: 8 }, (_, index) => ({ type: 'image' as const, data: `image-${index}`, mimeType: 'image/png' }))
    const history = [{ ...message, content: images }] as AgentMessage[]
    const synchronous = sanitizePiContextMessages(history)
    const asynchronous = await sanitizePiContextMessagesWithImages(history)
    expect(synchronous).toEqual(asynchronous)
    const content = (asynchronous[0] as { content: Array<{ type: string; data?: string }> }).content
    expect(content.filter((block) => block.type === 'image').map((block) => block.data)).toEqual(['image-4', 'image-5', 'image-6', 'image-7'])
    expect((history[0] as ToolResultMessage).content).toEqual(images)
  })

  test('Given 图片已因字节预算降级 When 追加小图并恢复历史 Then 既有图片表示保持一致', async () => {
    const budgetTranscoder: PiImageTranscoderPort = {
      async transcode(input, options) {
        if (input.data.startsWith('small')) return { data: 'small', mimeType: 'image/jpeg' }
        return { data: 'B'.repeat(options.maxSide === 1600 ? 2_000_000 : 200_000), mimeType: 'image/jpeg' }
      },
    }
    const history = Array.from({ length: 4 }, (_, index) => ({
      ...screenshot(index), content: [{ type: 'image', data: 'A'.repeat(3_000_000), mimeType: 'image/png' }],
    })) as AgentMessage[]
    const before = await sanitizePiContextMessagesWithImages(history, budgetTranscoder)
    const extended = [...history, { ...screenshot(4), content: [{ type: 'image', data: 'small-original', mimeType: 'image/png' }] }] as AgentMessage[]
    const after = await sanitizePiContextMessagesWithImages(extended, budgetTranscoder)
    expect(after.slice(0, history.length)).toEqual(before)
    expect(await sanitizePiContextMessagesWithImages(JSON.parse(JSON.stringify(extended)), budgetTranscoder)).toEqual(after)
    const base64Bytes = after.reduce((sum, message) => message.role === 'toolResult'
      ? sum + message.content.reduce((count, block) => count + (block.type === 'image' ? block.data.length : 0), 0)
      : sum, 0)
    expect(base64Bytes).toBeLessThanOrEqual(6 * 1024 * 1024)
  })

  test('Given 多张预算内小图的恢复历史 When 只需张数整理 Then 不转码最终会被丢弃的图片', async () => {
    const calls: string[] = []
    const history = Array.from({ length: 80 }, (_, index) => screenshot(index))
    const result = await sanitizePiContextMessagesWithImages(history, {
      async transcode(input, options) {
        calls.push(input.data)
        return transcoder.transcode(input, options)
      },
    })
    const retainedCount = result.reduce((count, message) => message.role === 'toolResult'
      ? count + message.content.filter(block => block.type === 'image').length
      : count, 0)
    expect(retainedCount).toBe(4)
    expect(calls).toHaveLength(retainedCount)
    const withoutTranscoding = await sanitizePiContextMessagesWithImages(history)
    const imageIndexes = (messages: AgentMessage[]) => messages.flatMap((message, index) => message.role === 'toolResult'
      && message.content.some(block => block.type === 'image') ? [index] : [])
    expect(imageIndexes(result)).toEqual(imageIndexes(withoutTranscoding))
  })

  test('Given 图片已超过张数上限 When 再加入小图片 Then 成批腾出的空间不会使旧图重新出现', async () => {
    const history = Array.from({ length: 7 }, (_, index) => screenshot(index))
    const before = await sanitizePiContextMessagesWithImages(history, transcoder)
    const after = await sanitizePiContextMessagesWithImages([...history, screenshot(7)], transcoder)
    expect(after.slice(0, history.length)).toEqual(before)
    expect(JSON.parse(JSON.stringify(history))).toEqual(history)
  })
})
