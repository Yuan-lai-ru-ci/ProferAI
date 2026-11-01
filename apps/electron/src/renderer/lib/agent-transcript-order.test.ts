import { describe, expect, test } from 'bun:test'
import { orderTranscriptMessages } from './agent-transcript-order'

interface Msg { type: string; uuid?: string; _createdAt?: number; text?: string }

const msg = (type: string, createdAt: number | undefined, uuid: string, text?: string): Msg => ({ type, uuid, _createdAt: createdAt, text })

describe('渲染前消息顺序归一化', () => {
  test('Given 分页拼接导致后一段排在前一段前面 When 归一化 Then 按时间还原顺序', () => {
    const a = msg('assistant', 100, 'a')
    const b = msg('assistant', 200, 'b')
    const c = msg('assistant', 300, 'c')

    const result = orderTranscriptMessages([b, c, a])
    expect(result.map((m) => m.uuid)).toEqual(['a', 'b', 'c'])
  })

  test('Given 同一条消息出现两次 When 归一化 Then 去重且保留第一次出现的位置与最后一次的内容', () => {
    const first = msg('assistant', 100, 'x', '旧内容')
    const other = msg('assistant', 200, 'y', '别的内容')
    const latest = msg('assistant', 100, 'x', '新内容')

    const result = orderTranscriptMessages([first, other, latest])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ uuid: 'x', text: '新内容' })
    expect(result[1]).toMatchObject({ uuid: 'y' })
  })

  test('Given 没有时间戳的消息 When 归一化 Then 跟随前一条保持相对位置', () => {
    const a = msg('assistant', 100, 'a')
    const sys = msg('system', undefined, 's')
    const b = msg('assistant', 200, 'b')

    const result = orderTranscriptMessages([a, sys, b])
    expect(result.map((m) => m.uuid)).toEqual(['a', 's', 'b'])
  })

  test('Given 数组本来就有序且无重复 When 归一化 Then 返回同一个引用', () => {
    const list = [msg('assistant', 100, 'a'), msg('assistant', 200, 'b')]
    expect(orderTranscriptMessages(list)).toBe(list)
  })

  test('Given 空数组或单条 When 归一化 Then 原样返回', () => {
    const empty: Msg[] = []
    expect(orderTranscriptMessages(empty)).toBe(empty)
    const one = [msg('assistant', 100, 'a')]
    expect(orderTranscriptMessages(one)).toBe(one)
  })
})
