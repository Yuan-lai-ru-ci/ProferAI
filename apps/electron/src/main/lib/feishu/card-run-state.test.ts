import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, SDKAssistantMessage } from '@profer/shared'
import { createInitialState, reduce } from './card-run-state'

function assistant(text: string, uuid: string, partial = true): AgentStreamPayload {
  return {
    kind: 'sdk_message',
    message: {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      uuid,
      ...(partial ? { _partial: true } : {}),
    } as unknown as SDKAssistantMessage,
  }
}

describe('飞书流式卡片运行状态', () => {
  test('累计 partial assistant 快照只保留最新内容，不重复拼接', () => {
    let state = createInitialState()

    state = reduce(state, assistant('我可以帮你处理很多事情，例如：', 'assistant-1'))
    state = reduce(state, assistant('我可以帮你处理很多事情，例如：\n\n- 写作与整理', 'assistant-1'))
    state = reduce(state, assistant('我可以帮你处理很多事情，例如：\n\n- 写作与整理\n- 信息分析', 'assistant-1'))

    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]).toMatchObject({
      kind: 'text',
      content: '我可以帮你处理很多事情，例如：\n\n- 写作与整理\n- 信息分析',
      streaming: true,
    })
  })

  test('同一 assistant 的 final 快照替换最后一个 partial，而不是再次追加', () => {
    let state = createInitialState()

    state = reduce(state, assistant('第一段', 'assistant-1'))
    state = reduce(state, assistant('第一段\n\n第二段', 'assistant-1', false))

    expect(state.blocks).toHaveLength(1)
    expect(state.blocks[0]).toMatchObject({ kind: 'text', content: '第一段\n\n第二段' })
  })
})
