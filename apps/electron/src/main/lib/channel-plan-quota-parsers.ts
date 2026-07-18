import type { ChannelPlanQuotaWindow } from '@profer/shared'

type MiniMaxGeneralRemain = {
  current_interval_remaining_percent?: number
  current_weekly_total_count?: number
  current_weekly_remaining_percent?: number
  end_time?: number
  weekly_end_time?: number
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function resetAt(value?: number): Pick<ChannelPlanQuotaWindow, 'resetAt'> {
  if (!Number.isFinite(value)) return {}
  const timestamp = value! > 0 && value! < 10_000_000_000 ? value! * 1000 : value!
  return timestamp > 0 ? { resetAt: timestamp } : {}
}

/** MiniMax general 额度响应映射；0 是有效 weekly total，只有 null/undefined 表示该窗口缺失。 */
export function parseMiniMaxGeneralQuotaWindows(items: MiniMaxGeneralRemain[]): ChannelPlanQuotaWindow[] {
  const windows: ChannelPlanQuotaWindow[] = []
  for (const item of items) {
    const intervalRemaining = clampPercent(item.current_interval_remaining_percent ?? 100)
    windows.push({
      type: '5h', label: '每 5 小时', remainingPercent: intervalRemaining,
      usedPercent: clampPercent(100 - intervalRemaining), ...resetAt(item.end_time),
    })
    if (item.current_weekly_total_count != null) {
      const weeklyRemaining = clampPercent(item.current_weekly_remaining_percent ?? 100)
      windows.push({
        type: 'weekly', label: '每周额度', remainingPercent: weeklyRemaining,
        usedPercent: clampPercent(100 - weeklyRemaining), ...resetAt(item.weekly_end_time),
      })
    }
  }
  return windows
}
