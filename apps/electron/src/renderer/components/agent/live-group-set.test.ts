import { describe, expect, test } from 'bun:test'
import type { AssistantTurn, MessageGroup } from './SDKMessageRenderer'
import { findStreamingTurnGroup, hasAssistantOutputAfterLastUser, hasAssistantTurnInCurrentTurn } from './live-group-set'

const RUN_STARTED_AT = 1_800_000_000_000

function assistantTurn(createdAt: number): AssistantTurn {
  return {
    type: 'assistant-turn',
    assistantMessages: [{
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
      parent_tool_use_id: null,
      _createdAt: createdAt,
    } as AssistantTurn['assistantMessages'][number]],
    turnMessages: [],
    createdAt,
  }
}

const userGroup: MessageGroup = {
  type: 'user',
  message: { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } } as never,
}

const compactBoundaryGroup: MessageGroup = {
  type: 'system',
  message: { type: 'system', subtype: 'compact_boundary', message: '上下文已压缩' } as never,
}

describe('当前流式轮次识别', () => {
  test('Given 最后一轮不在 liveGroupSet 但其消息产生于本轮起点之后 When 查找 Then 仍判定为当前轮', () => {
    const turn = assistantTurn(RUN_STARTED_AT + 3_000)
    const group = findStreamingTurnGroup({
      allGroups: [userGroup, turn],
      liveGroupSet: new Set<MessageGroup>(),
      streaming: true,
      runStartedAt: RUN_STARTED_AT,
    })
    expect(group).toBe(turn)
  })

  test('Given 最后一轮来自上一轮（早于本轮起点） When 查找 Then 不把旧轮冒充成 live', () => {
    const oldTurn = assistantTurn(RUN_STARTED_AT - 60_000)
    expect(findStreamingTurnGroup({
      allGroups: [userGroup, oldTurn],
      liveGroupSet: new Set<MessageGroup>(),
      streaming: true,
      runStartedAt: RUN_STARTED_AT,
    })).toBeNull()
  })

  test('Given 缺少运行起点 When 查找 Then 保持原行为（只认 liveGroupSet）', () => {
    const turn = assistantTurn(RUN_STARTED_AT + 1_000)
    expect(findStreamingTurnGroup({
      allGroups: [turn],
      liveGroupSet: new Set<MessageGroup>(),
      streaming: true,
    })).toBeNull()
  })

  test('Given 最后一轮已在 liveGroupSet When 查找 Then 直接返回该轮', () => {
    const turn = assistantTurn(RUN_STARTED_AT - 10)
    expect(findStreamingTurnGroup({
      allGroups: [userGroup, turn],
      liveGroupSet: new Set<MessageGroup>([turn]),
      streaming: true,
      runStartedAt: RUN_STARTED_AT,
    })).toBe(turn)
  })

  test('Given 非流式 When 查找 Then 永远返回空', () => {
    const turn = assistantTurn(RUN_STARTED_AT + 1_000)
    expect(findStreamingTurnGroup({
      allGroups: [turn],
      liveGroupSet: new Set<MessageGroup>([turn]),
      streaming: false,
      runStartedAt: RUN_STARTED_AT,
    })).toBeNull()
  })
})

describe('本轮是否已有助手内容', () => {
  test('Given 用户消息后已有一轮助手输出 When 判断 Then 视为已有内容', () => {
    expect(hasAssistantTurnInCurrentTurn([userGroup, assistantTurn(RUN_STARTED_AT)])).toBe(true)
  })

  test('Given 只有用户消息 When 判断 Then 视为尚无内容（兜底气泡可以带头像）', () => {
    expect(hasAssistantTurnInCurrentTurn([userGroup])).toBe(false)
  })

  test('Given 空会话 When 判断 Then 视为尚无内容', () => {
    expect(hasAssistantTurnInCurrentTurn([])).toBe(false)
  })

  test('Given 助手输出后跟了 system 分隔 When 判断 Then 仍视为已有内容', () => {
    expect(hasAssistantTurnInCurrentTurn([userGroup, assistantTurn(RUN_STARTED_AT), compactBoundaryGroup])).toBe(true)
  })

  test('Given 助手输出后用户又发了新消息 When 判断 Then 新一轮尚无内容', () => {
    expect(hasAssistantTurnInCurrentTurn([userGroup, assistantTurn(RUN_STARTED_AT), userGroup])).toBe(false)
  })
})

describe('最后一条用户消息之后是否有助手输出（中断 badge 归属）', () => {
  test('Given 上一轮有助手输出且用户新消息之后无输出 When 判断 Then 视为无输出（badge 不应挂在上一轮）', () => {
    expect(hasAssistantOutputAfterLastUser([userGroup, assistantTurn(RUN_STARTED_AT), userGroup])).toBe(false)
  })

  test('Given 最后一条用户消息之后已有助手轮 When 判断 Then 视为有输出', () => {
    expect(hasAssistantOutputAfterLastUser([userGroup, assistantTurn(RUN_STARTED_AT)])).toBe(true)
  })

  test('Given 助手轮与最后用户消息之间隔着 system 分隔 When 判断 Then 跳过分隔继续向前判定', () => {
    expect(hasAssistantOutputAfterLastUser([userGroup, assistantTurn(RUN_STARTED_AT), userGroup, compactBoundaryGroup])).toBe(false)
    expect(hasAssistantOutputAfterLastUser([userGroup, compactBoundaryGroup, assistantTurn(RUN_STARTED_AT)])).toBe(true)
  })

  test('Given 空会话 When 判断 Then 视为无输出', () => {
    expect(hasAssistantOutputAfterLastUser([])).toBe(false)
  })
})
