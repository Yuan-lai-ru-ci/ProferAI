import { describe, expect, test } from 'bun:test'
import { groupNavigationTurns } from './navigation-turns'

type Item = {
  id: string | null
  role: 'user' | 'assistant' | 'status'
  preview: string
  matchKey?: string
  startsTurn?: boolean
}

const user = (id: string, preview = `问 ${id}`): Item => ({ id, role: 'user', preview })
const assistant = (id: string, preview = `答 ${id}`): Item => ({ id, role: 'assistant', preview })
const status = (createdAt: number, preview = '已被用户中断'): Item => ({
  id: null,
  role: 'status',
  preview,
  matchKey: `status:interruption_record:${createdAt}`,
})

describe('groupNavigationTurns', () => {
  test('用户消息开新轮，助手回复并入同一轮', () => {
    const turns = groupNavigationTurns([user('u1'), assistant('a1'), user('u2'), assistant('a2')])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.anchor.id).toBe('u1')
    expect(turns[0]!.user?.id).toBe('u1')
    expect(turns[0]!.assistant?.id).toBe('a1')
    expect(turns[0]!.items).toHaveLength(2)
    expect(turns[0]!.preview).toBe('问 u1')
    expect(turns[1]!.anchor.id).toBe('u2')
  })

  test('收尾状态并进上一轮，不单独占一轮', () => {
    const turns = groupNavigationTurns([user('u1'), assistant('a1'), status(1000)])

    expect(turns).toHaveLength(1)
    expect(turns[0]!.status?.preview).toBe('已被用户中断')
    expect(turns[0]!.items).toHaveLength(3)
    // 预览仍然取用户提问，不因为中断状态被顶掉
    expect(turns[0]!.preview).toBe('问 u1')
  })

  test('多段助手回复只取首条做预览，但全部留在 items 里', () => {
    const turns = groupNavigationTurns([user('u1'), assistant('a1'), assistant('a2')])

    expect(turns).toHaveLength(1)
    expect(turns[0]!.assistant?.id).toBe('a1')
    expect(turns[0]!.items.map((item) => item.id)).toEqual(['u1', 'a1', 'a2'])
  })

  test('会话以助手/状态开场时自成一「无提问轮」', () => {
    const turns = groupNavigationTurns([status(1000), assistant('a1'), user('u1'), assistant('a2')])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.anchor.id).toBeNull()
    // 预览优先级：用户 > 助手 > 状态；这条无提问轮有助手回复，就取助手
    expect(turns[0]!.preview).toBe('答 a1')
    expect(turns[0]!.status?.preview).toBe('已被用户中断')
    expect(turns[1]!.anchor.id).toBe('u1')
  })

  test('轮键唯一，且与条目键同源（有 uuid 用 uuid，无 uuid 用 matchKey）', () => {
    const turns = groupNavigationTurns([status(1000), user('u1'), user('u2')])

    expect(turns.map((turn) => turn.key)).toEqual([
      'key:status:interruption_record:1000',
      'u1',
      'u2',
    ])
    expect(new Set(turns.map((turn) => turn.key)).size).toBe(turns.length)
  })

  test('子会话返回状态卡单独开一轮，普通状态仍并入前一轮', () => {
    const returned: Item = { id: 'return-1', role: 'status', preview: '子会话返回：检索、核对', startsTurn: true }
    const turns = groupNavigationTurns([user('u1'), assistant('a1'), returned, assistant('a2')])

    expect(turns).toHaveLength(2)
    expect(turns[0]!.items.map((item) => item.id)).toEqual(['u1', 'a1'])
    expect(turns[1]!.anchor.id).toBe('return-1')
    expect(turns[1]!.status?.id).toBe('return-1')
    expect(turns[1]!.assistant?.id).toBe('a2')
  })
  test('空输入返回空数组', () => {
    expect(groupNavigationTurns([])).toEqual([])
  })
})
