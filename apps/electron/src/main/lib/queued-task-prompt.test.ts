import { describe, expect, test } from 'bun:test'
import { appendAgentTaskPrompt } from '@profer/shared'

function selectQueuedTaskPrompt(input: {
  text: string
  rawText?: string
  taskPromptForMessage: (message: string) => string
}): { taskPrompt: string; persistedText: string } {
  const original = input.rawText ?? input.text
  return {
    taskPrompt: input.taskPromptForMessage(original),
    persistedText: original,
  }
}

describe('队列消息的任务指导边界', () => {
  test('Given 活跃run冻结了工具集合 When 用户追加网页任务 Then guidance只进入provider消息且门禁依据原始输入', () => {
    const queued = selectQueuedTaskPrompt({
      text: '打开网页。',
      rawText: '打开网页。',
      taskPromptForMessage(message) { return /网页/.test(message) ? 'BROWSER_GUIDANCE' : '' },
    })
    const providerText = appendAgentTaskPrompt(queued.persistedText, queued.taskPrompt, false)
    expect(queued.taskPrompt).toBe('BROWSER_GUIDANCE')
    expect(queued.persistedText).toBe('打开网页。')
    expect(providerText).toContain('<turn_guidance>')
    expect(providerText).toContain('BROWSER_GUIDANCE')
  })

  test('Given 非Pi/轻量或工具门禁不命中 When 计算队列任务指导 Then 保持原消息', () => {
    const message = '打开网页。'
    const queued = selectQueuedTaskPrompt({ text: message, rawText: message, taskPromptForMessage: () => '' })
    expect(queued.taskPrompt).toBe('')
    expect(appendAgentTaskPrompt(message, queued.taskPrompt, false)).toBe(message)
  })

  test('Given /compact queue command When guidance exists Then the command is not decorated', () => {
    expect(appendAgentTaskPrompt('/compact', 'BROWSER_GUIDANCE', true)).toBe('/compact')
  })
})
