import { describe, expect, test } from 'bun:test'

const chatMessagesSource = await Bun.file(`${import.meta.dir}/ChatMessages.tsx`).text()
const parallelChatMessagesSource = await Bun.file(`${import.meta.dir}/ParallelChatMessages.tsx`).text()

describe('流式 Chat Markdown 渲染', () => {
  test('标准 Chat 直接把最新流式内容交给 Markdown renderer', () => {
    expect(chatMessagesSource).toContain('<MessageResponse>{visibleContent}</MessageResponse>')
    expect(chatMessagesSource).toContain('const visibleContent = streamingContent || smoothContent')
  })

  test('并排 Chat 直接把最新流式内容交给 Markdown renderer', () => {
    expect(parallelChatMessagesSource).toContain('<MessageResponse>{streamingContent}</MessageResponse>')
  })
})
