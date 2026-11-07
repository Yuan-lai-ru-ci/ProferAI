import { describe, expect, test } from 'bun:test'
import { aggregateHeatmapEntries, computePercentileThresholds, toCalendarData } from './heatmap-utils'

describe('heatmap-utils', () => {
  test('按日期合并多个工作区，并按日期升序返回', () => {
    expect(aggregateHeatmapEntries([
      [{ date: '2026-01-03', tokens: 30 }, { date: '2026-01-01', tokens: 10 }],
      [{ date: '2026-01-01', tokens: 5 }, { date: '2026-01-02', tokens: 20 }],
    ])).toEqual([
      { date: '2026-01-01', tokens: 15 },
      { date: '2026-01-02', tokens: 20 },
      { date: '2026-01-03', tokens: 30 },
    ])
  })

  test('空工作区和零用量不会制造活跃日或颜色等级', () => {
    expect(aggregateHeatmapEntries([[], [{ date: '2026-01-01', tokens: 0 }]])).toEqual([{ date: '2026-01-01', tokens: 0 }])
    expect(toCalendarData([{ date: '2026-01-01', tokens: 0 }])).toEqual([{ date: '2026-01-01', tokens: 0, level: 0 }])
  })

  test('分级阈值只使用非零 Token 值', () => {
    expect(computePercentileThresholds([0, 10, 20, 30, 40])).toEqual([10, 20, 30])
  })
})
