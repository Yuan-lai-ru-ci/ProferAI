import { describe, expect, test } from 'bun:test'
import { PI_REAL_USAGE_COMPACTION_RATIO, shouldCompactByRealUsage } from '../pi-agent-adapter'

const WINDOW = 200_000

function assistant(input: number, cacheRead = 0) {
  return { role: 'assistant', usage: { input, cacheRead } }
}

describe('shouldCompactByRealUsage', () => {
  test('真实占用达到阈值时触发', () => {
    const messages = [assistant(100_000, 70_000)] // 170k / 200k = 85%
    expect(shouldCompactByRealUsage(messages, WINDOW)).toBe(true)
  })

  test('真实占用低于阈值时不触发', () => {
    const messages = [assistant(50_000, 30_000)] // 80k / 200k = 40%
    expect(shouldCompactByRealUsage(messages, WINDOW)).toBe(false)
  })

  test('缓存读取计入占用（否则会严重低估）', () => {
    const messages = [assistant(1_000, 165_000)] // input 很小但缓存很大
    expect(shouldCompactByRealUsage(messages, WINDOW)).toBe(true)
  })

  test('只认最后一条有 usage 的 assistant 消息', () => {
    const messages = [
      assistant(190_000), // 早期很高
      { role: 'user' },
      assistant(2_000), // 压缩后已经降下来
    ]
    expect(shouldCompactByRealUsage(messages, WINDOW)).toBe(false)
  })

  test('没有 assistant 消息时不触发', () => {
    expect(shouldCompactByRealUsage([{ role: 'user' }], WINDOW)).toBe(false)
  })

  test('assistant 缺 usage 时继续往前找，不会误判触发', () => {
    const messages = [{ role: 'assistant' }, assistant(10_000)]
    expect(shouldCompactByRealUsage(messages, WINDOW)).toBe(false)
  })

  test('缺少上下文窗口信息时不触发（避免除零式误判）', () => {
    expect(shouldCompactByRealUsage([assistant(999_999)], undefined)).toBe(false)
    expect(shouldCompactByRealUsage([assistant(999_999)], 0)).toBe(false)
  })

  test('边界值按包含处理', () => {
    const exactly = WINDOW * PI_REAL_USAGE_COMPACTION_RATIO
    expect(shouldCompactByRealUsage([assistant(exactly)], WINDOW)).toBe(true)
    expect(shouldCompactByRealUsage([assistant(exactly - 1)], WINDOW)).toBe(false)
  })

  test('阈值比例可覆盖', () => {
    const messages = [assistant(100_000)]
    expect(shouldCompactByRealUsage(messages, WINDOW, 0.4)).toBe(true)
    expect(shouldCompactByRealUsage(messages, WINDOW, 0.6)).toBe(false)
  })

  test('1M 窗口按 80% 触发，不被绝对上限提前压缩', () => {
    const oneMillion = 1_000_000
    // 353,427 是真实事故会话的峰值输入；1M 窗口下只占 35%，不应触发。
    expect(shouldCompactByRealUsage([assistant(250_000, 103_427)], oneMillion)).toBe(false)
    expect(shouldCompactByRealUsage([assistant(500_000, 299_999)], oneMillion)).toBe(false)
    // 到 80% 才压。
    expect(shouldCompactByRealUsage([assistant(600_000, 200_000)], oneMillion)).toBe(true)
    expect(shouldCompactByRealUsage([assistant(600_000, 199_999)], oneMillion)).toBe(false)
  })
})
