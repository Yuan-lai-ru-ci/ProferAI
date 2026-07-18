import { describe, expect, test } from 'bun:test'
import { parseMiniMaxGeneralQuotaWindows } from './channel-plan-quota-parsers'

describe('MiniMax Token Plan 周额度解析', () => {
  test('Given weekly total 为 0 When 解析 Then 仍保留周额度窗口及 API 剩余百分比', () => {
    const windows = parseMiniMaxGeneralQuotaWindows([{
      current_interval_remaining_percent: 80,
      current_weekly_total_count: 0,
      current_weekly_remaining_percent: 0,
    }])
    expect(windows).toEqual([
      expect.objectContaining({ type: '5h', remainingPercent: 80 }),
      expect.objectContaining({ type: 'weekly', remainingPercent: 0, usedPercent: 100 }),
    ])
  })

  test('Given weekly total 缺失 When 解析 Then 不虚构周额度窗口', () => {
    const windows = parseMiniMaxGeneralQuotaWindows([{ current_interval_remaining_percent: 75 }])
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ type: '5h', remainingPercent: 75 })
  })
})
