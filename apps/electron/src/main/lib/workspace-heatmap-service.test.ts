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
    expect(CACHE_VERSION).toBe(4)
  })

  test('当天后续数据不被锁死：从快照日当天继续合并（覆盖当天）', () => {
    // 模拟：缓存昨天 8/1 已有数据，增量缺口却发生在 8/1 当天晚些（cachedDate 覆盖）
    const daily = [{ date: '2026-08-01', tokens: 10_000 }]
    // fromDate = lastSnapshotDate 当天（8/1），重扫全量 8/1 = 128_000
    const incremental = new Map<string, number>([['2026-08-01', 128_000]])
    const merged = mergeDaily(daily, incremental, '2026-08-01')
    expect(merged.find((d) => d.date === '2026-08-01')?.tokens).toBe(128_000)
  })

  test('跨天增量补录不跳过快照日：8/2 缺口被补录且不重复累加 8/3', () => {
    const daily = [{ date: '2026-08-01', tokens: 128_000 }]
    // lastSnapshotDate=8/1，fromDate=8/1，扫描 [8/1, 8/3]
    const incremental = new Map<string, number>([
      ['2026-08-01', 128_000], // 覆盖
      ['2026-08-02', 92_000_000], // 补录
      ['2026-08-03', 20_000_000], // 补录
    ])
    const merged = mergeDaily(daily, incremental, '2026-08-01')
    expect(merged).toEqual([
      { date: '2026-08-01', tokens: 128_000 },
      { date: '2026-08-02', tokens: 92_000_000 },
      { date: '2026-08-03', tokens: 20_000_000 },
    ])
  })

  test('对 fromDate 之后的日期已在缓存时累加成正确增量，不重复计数', () => {
    // 极端：fromDate 之后某天缓存已有部分，增量是该天新追加的部分
    const daily = [{ date: '2026-08-03', tokens: 5_000 }]
    const incremental = new Map<string, number>([['2026-08-03', 7_000]])
    const merged = mergeDaily(daily, incremental, '2026-08-02')
    // 8/3 非 fromDate → 累加 5000+7000
    expect(merged.find((d) => d.date === '2026-08-03')?.tokens).toBe(12_000)
  })
})
