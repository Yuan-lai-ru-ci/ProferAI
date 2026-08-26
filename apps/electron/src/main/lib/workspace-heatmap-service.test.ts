import { describe, expect, test } from 'bun:test'
import { CACHE_VERSION, timestampToLocalDate, usageToTotalTokens, mergeDaily } from './workspace-heatmap-service'

describe('工作区热力图 Token 统计', () => {
  test('统计输入、缓存读写与输出 Token', () => {
    expect(usageToTotalTokens({
      input_tokens: 8_498,
      cache_read_input_tokens: 1_084_160,
      cache_creation_input_tokens: 32_000,
      output_tokens: 1_187,
    })).toBe(1_125_845)
  })

  test('缺失的 usage 字段按零处理', () => {
    expect(usageToTotalTokens({ input_tokens: 10, output_tokens: 5 })).toBe(15)
    expect(usageToTotalTokens({})).toBe(0)
  })

  test('日期按运行设备的本机自然日归属，而不是 UTC 日期', () => {
    const timestamp = Date.parse('2026-07-18T17:00:00.000Z')
    const date = new Date(timestamp)
    const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

    expect(timestampToLocalDate(timestamp)).toBe(expected)
  })

  test('升级缓存版本以使旧统计口径自动失效', () => {
    expect(CACHE_VERSION).toBe(5)
  })

  test('已结算日期采用覆盖，重复补算不会重复计数', () => {
    const daily = [{ date: '2026-08-01', tokens: 10_000 }]
    const incremental = new Map<string, number>([['2026-08-01', 128_000]])
    expect(mergeDaily(daily, incremental)).toEqual([
      { date: '2026-08-01', tokens: 128_000 },
    ])
  })

  test('跨多天补算时写入每个已结算日期', () => {
    const daily = [{ date: '2026-08-01', tokens: 128_000 }]
    const incremental = new Map<string, number>([
      ['2026-08-02', 92_000_000],
      ['2026-08-03', 20_000_000],
    ])
    expect(mergeDaily(daily, incremental)).toEqual([
      { date: '2026-08-01', tokens: 128_000 },
      { date: '2026-08-02', tokens: 92_000_000 },
      { date: '2026-08-03', tokens: 20_000_000 },
    ])
  })

  test('合并结果不包含当天之外的重复增量', () => {
    const daily = [{ date: '2026-08-03', tokens: 5_000 }]
    const incremental = new Map<string, number>([['2026-08-03', 7_000]])
    expect(mergeDaily(daily, incremental).find((d) => d.date === '2026-08-03')?.tokens).toBe(7_000)
  })
})
