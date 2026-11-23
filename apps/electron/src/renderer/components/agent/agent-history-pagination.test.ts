import { describe, expect, test } from 'bun:test'
import { clipAgentHistoryAfterRewind, normalizeAgentHistoryRefresh, normalizeAgentHistoryResult } from './agent-history-pagination'

const message = (id: string) => ({ type: 'user', uuid: id } as never)
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => message(`m${from + i}`))
const uuids = (messages: readonly unknown[]) => messages.map((item) => (item as { uuid: string }).uuid)

test('修改重发先移除旧轮，保留锚点和前面的无 UUID 记录，再插入同正文的新消息', () => {
  const boundary = message('previous-answer')
  const withoutUuid = { type: 'system', subtype: 'status' } as const
  const old = { ...message('old-user') as object, text: 'same text', uuid: 'old-user' }
  const sent = { ...old, uuid: 'new-user' }
  const page = [withoutUuid, boundary, old, message('old-assistant')] as unknown as Parameters<typeof clipAgentHistoryAfterRewind>[0]
  const kept = clipAgentHistoryAfterRewind(page, { kind: 'message', messageUuid: 'previous-answer' })
  expect([...kept, sent]).toEqual([withoutUuid, boundary, sent])
  expect(clipAgentHistoryAfterRewind(page, { kind: 'session-start' })).toEqual([])
  expect(clipAgentHistoryAfterRewind(page, { kind: 'message', messageUuid: 'outside-loaded-page' })).toEqual([])
})

describe('Agent history pagination compatibility', () => {
  test('legacy arrays preserve cursor and use the legacy hasMore signal', () => {
    const result = normalizeAgentHistoryResult(
      [message('older')],
      { startIndex: 60, hasMore: true },
      true,
    )
    expect(result.messages.map((item) => (item as { uuid: string }).uuid)).toEqual(['older'])
    expect(result.cursor).toEqual({ startIndex: 59, hasMore: true })
    expect(result.isPage).toBe(false)
  })

  test('legacy empty arrays stop when the compatibility signal says no more', () => {
    const result = normalizeAgentHistoryResult([], { startIndex: 0, hasMore: true }, false)
    expect(result.cursor).toEqual({ startIndex: 0, hasMore: false })
  })

  test('page cursor advances backwards and missing cursor falls back by page length', () => {
    expect(normalizeAgentHistoryResult(
      { messages: [message('a')], startIndex: 20, hasMore: true },
      { startIndex: 60, hasMore: true },
    ).cursor).toEqual({ startIndex: 20, hasMore: true })
    expect(normalizeAgentHistoryResult(
      { messages: [message('a'), message('b')], hasMore: true },
      { startIndex: 20, hasMore: true },
    ).cursor).toEqual({ startIndex: 18, hasMore: true })
  })

  test('cursor at zero stops even if page omits hasMore', () => {
    expect(normalizeAgentHistoryResult(
      { messages: [message('a')], startIndex: 0 },
      { startIndex: 20, hasMore: true },
    ).cursor.hasMore).toBe(false)
  })
})

describe('Agent history refresh normalization', () => {
  test('refresh 裁掉超出原起点的前缀：窗口起点不动，只追加尾部新消息', () => {
    // 场景：已加载 100 条（起点 900），refresh 以 tail = 100 + 100 重新拉回 200 条（起点 800）。
    const page = normalizeAgentHistoryResult(
      { messages: range(800, 200), startIndex: 800, hasMore: true },
      { startIndex: 900, hasMore: true },
    )
    const refreshed = normalizeAgentHistoryRefresh(page, 900)
    expect(refreshed.clippedCount).toBe(100)
    expect(refreshed.cursor).toEqual({ startIndex: 900, hasMore: true })
    expect(refreshed.messages).toHaveLength(100)
    expect(uuids(refreshed.messages)[0]).toBe('m900')
  })

  test('连续多次 refresh 不再累积膨胀', () => {
    let startIndex = 900
    let hasMore = true
    for (let round = 0; round < 3; round += 1) {
      // 每一轮都按「当前已加载条数 + 余量」取页，模拟 AgentView 的 tail 计算。
      const loaded = startIndex >= 0 ? 1000 - startIndex : 0
      const pageStart = Math.max(0, 1000 - (loaded + 100))
      const page = normalizeAgentHistoryResult(
        { messages: range(pageStart, 1000 - pageStart), startIndex: pageStart, hasMore: pageStart > 0 },
        { startIndex, hasMore },
      )
      const refreshed = normalizeAgentHistoryRefresh(page, startIndex)
      startIndex = refreshed.cursor.startIndex
      hasMore = refreshed.cursor.hasMore
      expect(refreshed.messages).toHaveLength(100)
    }
    expect(startIndex).toBe(900)
    expect(hasMore).toBe(true)
  })

  test('窗口未前移时不裁剪', () => {
    const page = normalizeAgentHistoryResult(
      { messages: range(900, 100), startIndex: 900, hasMore: true },
      { startIndex: 900, hasMore: true },
    )
    const refreshed = normalizeAgentHistoryRefresh(page, 900)
    expect(refreshed.clippedCount).toBe(0)
    expect(refreshed.messages).toHaveLength(100)
  })

  test('rewind 截断文件后窗口重置：整页保留，不裁空', () => {
    // 回退把文件截到 300 行，返回页整页都早于原起点 700。
    const page = normalizeAgentHistoryResult(
      { messages: range(0, 300), startIndex: 0, hasMore: false },
      { startIndex: 700, hasMore: true },
    )
    const refreshed = normalizeAgentHistoryRefresh(page, 700)
    expect(refreshed.clippedCount).toBe(0)
    expect(refreshed.messages).toHaveLength(300)
    expect(refreshed.cursor).toEqual({ startIndex: 0, hasMore: false })
  })

  test('会话切换（previousStartIndex 为 null）不裁剪', () => {
    const page = normalizeAgentHistoryResult(
      { messages: range(740, 260), startIndex: 740, hasMore: true },
      { startIndex: 0, hasMore: true },
    )
    const refreshed = normalizeAgentHistoryRefresh(page, null)
    expect(refreshed.clippedCount).toBe(0)
    expect(refreshed.messages).toHaveLength(260)
  })

  test('旧版纯数组返回不裁剪', () => {
    const page = normalizeAgentHistoryResult([message('legacy')], { startIndex: 60, hasMore: true }, true)
    const refreshed = normalizeAgentHistoryRefresh(page, 60)
    expect(page.isPage).toBe(false)
    expect(refreshed.clippedCount).toBe(0)
    expect(refreshed.messages).toHaveLength(1)
  })

  test('裁剪后起点等于原起点；即使页面声称到头也不能误报 hasMore=false', () => {
    // 页面已拉到文件开头（startIndex 0、hasMore false），但原窗口起点是 40，
    // 说明 0..39 确实还有历史，裁剪后必须保持 hasMore = true。
    const page = normalizeAgentHistoryResult(
      { messages: range(0, 100), startIndex: 0, hasMore: false },
      { startIndex: 40, hasMore: true },
    )
    const refreshed = normalizeAgentHistoryRefresh(page, 40)
    expect(refreshed.cursor).toEqual({ startIndex: 40, hasMore: true })
    expect(refreshed.clippedCount).toBe(40)
    expect(refreshed.messages).toHaveLength(60)
    expect(uuids(refreshed.messages)[0]).toBe('m40')
  })
})
