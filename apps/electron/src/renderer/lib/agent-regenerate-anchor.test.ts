import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@profer/shared'
import { getUserTextFromSDKMessage, resolveRegenerateTarget, shouldRegenerateFromRetry } from './agent-regenerate-anchor'

function user(text: string, uuid = `u-${text}`): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function assistant(uuid: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text: `回复 ${uuid}` }] },
    parent_tool_use_id: parentToolUseId,
  } as unknown as SDKMessage
}

function toolResultUser(): SDKMessage {
  return {
    type: 'user',
    uuid: 'tr-1',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function goalIteration(): SDKMessage {
  return {
    type: 'user',
    uuid: 'goal-1',
    _goalIteration: 2,
    message: { content: [{ type: 'text', text: '继续完成目标' }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('resolveRegenerateTarget（重新生成目标）', () => {
  test('普通两轮：回退锚点为上一轮的 assistant 消息', () => {
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a1'),
      user('第二问', 'u2'),
      assistant('a2'),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a1' })
  })

  test('同一轮内多条 assistant：取该轮最后一条', () => {
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a1'),
      assistant('a2'),
      user('第二问', 'u2'),
      assistant('a3'),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a2' })
  })

  test('子代理 assistant 消息不作为回退锚点', () => {
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a-main'),
      assistant('a-sub', 'toolu-1'),
      user('第二问', 'u2'),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a-main' })
  })

  test('tool_result 用户消息不算用户发言', () => {
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a1'),
      user('第二问', 'u2'),
      assistant('a2'),
      toolResultUser(),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a1' })
  })

  test('Goal 迭代控制消息不算用户发言', () => {
    // 若 Goal 迭代消息被当成用户发言，锚点会错落到 a2。
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a1'),
      user('第二问', 'u2'),
      assistant('a2'),
      goalIteration(),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a1' })
  })

  test('没有用户消息时返回 undefined（没有可重发的文本）', () => {
    expect(resolveRegenerateTarget([])).toBeUndefined()
    expect(resolveRegenerateTarget([assistant('a1')])).toBeUndefined()
  })

  test('首轮就失败（用户消息之前没有 assistant）→ 目标为清空整段对话', () => {
    expect(resolveRegenerateTarget([user('首条提问', 'u1'), assistant('a1')]))
      .toEqual({ kind: 'reset', userMessage: '首条提问' })
  })

  test('首轮失败且已有错误卡片时仍为 reset（错误消息不算可保留的锚点）', () => {
    const errorAssistant = {
      type: 'assistant',
      uuid: 'a-err',
      message: { content: [{ type: 'text', text: '出错了' }] },
      parent_tool_use_id: null,
      error: { message: '出错了', errorType: 'unknown_error' },
    } as unknown as SDKMessage
    expect(resolveRegenerateTarget([user('首条提问', 'u1'), errorAssistant]))
      .toEqual({ kind: 'reset', userMessage: '首条提问' })
  })

  test('assistant 消息缺 uuid 时继续向前找', () => {
    const noUuid = { type: 'assistant', message: { content: [] }, parent_tool_use_id: null } as unknown as SDKMessage
    expect(resolveRegenerateTarget([
      user('第一问', 'u1'),
      assistant('a1'),
      noUuid,
      user('第二问', 'u2'),
    ])).toEqual({ kind: 'rewind', userMessage: '第二问', rewindToAssistantUuid: 'a1' })
  })
})

describe('getUserTextFromSDKMessage', () => {
  test('拼接多个 text 块', () => {
    const multi = {
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    expect(getUserTextFromSDKMessage(multi)).toBe('a\nb')
  })

  test('tool_result / 子代理 / 合成消息返回 null', () => {
    expect(getUserTextFromSDKMessage(toolResultUser())).toBeNull()
    expect(getUserTextFromSDKMessage(assistant('a1'))).toBeNull()
    const synthetic = {
      type: 'user',
      uuid: 'u2',
      isSynthetic: true,
      message: { content: [{ type: 'text', text: '系统注入' }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    expect(getUserTextFromSDKMessage(synthetic)).toBeNull()
  })
})

describe('shouldRegenerateFromRetry（错误卡片重试是否改走重新生成）', () => {
  test('最新一轮且会话空闲时改走重新生成', () => {
    expect(shouldRegenerateFromRetry({ isLatestTurn: true, sessionActive: false })).toBe(true)
  })

  test('历史轮次的错误卡片不改走，避免截断与本卡片无关的最新一轮', () => {
    expect(shouldRegenerateFromRetry({ isLatestTurn: false, sessionActive: false })).toBe(false)
  })

  test('会话活跃（流式/后台任务/子 Agent）时不改走', () => {
    expect(shouldRegenerateFromRetry({ isLatestTurn: true, sessionActive: true })).toBe(false)
  })
})
