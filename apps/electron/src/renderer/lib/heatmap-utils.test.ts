import { describe, expect, test } from 'bun:test'
import { aggregateHeatmapEntries, computePercentileThresholds, isScrolledToEnd, toCalendarData } from './heatmap-utils'

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

  test('只有停在最右端才算钉住最新日期', () => {
    const grid = { scrollWidth: 697, clientWidth: 521 }
    expect(isScrolledToEnd({ ...grid, scrollLeft: 176 })).toBe(true)
    // 容器变窄后旧位置不再是尾部：对应「缩窗时右侧被推出视野」的回归
    expect(isScrolledToEnd({ scrollWidth: 697, clientWidth: 350, scrollLeft: 176 })).toBe(false)
    // 差 1px 的取整误差仍视为钉住，避免每次滚动都掉锚
    expect(isScrolledToEnd({ ...grid, scrollLeft: 175 })).toBe(true)
    expect(isScrolledToEnd({ ...grid, scrollLeft: 0 })).toBe(false)
    // 内容能完整放下时（无溢出）永远算钉住
    expect(isScrolledToEnd({ scrollWidth: 500, clientWidth: 600, scrollLeft: 0 })).toBe(true)
  })
})
